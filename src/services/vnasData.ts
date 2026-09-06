/**
 * Airports and scenarios, from the baked catalog (default) or live from vNAS
 * through a user-run CORS proxy. The source is chosen per call so the app can
 * switch when the proxy setting changes. Loaded airport files are cached here,
 * outside the Model, so scenario lookups do not need the whole file in the Model.
 */
import { Context, Data, Effect, Layer, Ref, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { AirportFile, CatalogIndex, type Scenario } from '../domain/catalog'
import { API, type ArtccDocument, type VnasScenario, type VnasTrainingAirport, assembleAirport, compactMap, compactScenario, facilityIndex, parseLenientJSON, scenarioForAirport } from '../domain/vnas'
import { HttpError, HttpText } from './http'

export class DataError extends Data.TaggedError('DataError')<{ message: string }> {}

export const DataSource = defineTaggedUnion({
  Catalog: {},
  Live: { proxy: Schema.String },
})
export type DataSource = typeof DataSource.Type

export const sourceForProxy = (proxy: string): DataSource =>
  proxy.trim() === '' ? DataSource.Catalog() : DataSource.Live({ proxy: proxy.trim() })

export type VnasDataShape = Readonly<{
  index: (source: DataSource) => Effect.Effect<CatalogIndex, DataError>
  airport: (source: DataSource, id: string, artcc: string) => Effect.Effect<AirportFile, DataError>
  /** the full scenario of an airport loaded earlier; the catalog has it inline, live mode fetches it */
  scenario: (source: DataSource, airportId: string, scenarioId: string) => Effect.Effect<Scenario, DataError>
}>

export class VnasData extends Context.Service<VnasData, VnasDataShape>()('VnasData') {}

export const CATALOG_BASE = 'catalog/'

const toDataError = (e: HttpError | Schema.SchemaError | Error): DataError =>
  new DataError({ message: e instanceof HttpError ? `${e.message} for ${e.url.split('?').pop()?.slice(0, 80)}` : String(e.message ?? e) })

const getJson = (http: HttpText['Service'], url: string) =>
  http.get(url).pipe(
    Effect.flatMap((text) =>
      Effect.try({ try: () => parseLenientJSON(text), catch: (e) => new Error(`bad JSON from ${url}: ${String(e)}`) }),
    ),
  )

const decode =
  <A>(schema: Schema.Codec<A, any, never, never>) =>
  (json: unknown) =>
    Schema.decodeUnknownEffect(schema)(json)

export const viaProxy = (proxy: string, url: string): string =>
  proxy.includes('{url}') ? proxy.replace('{url}', encodeURIComponent(url)) : proxy + encodeURIComponent(url)

type ArtccSummary = Readonly<{ id: string; name?: string | null }>
type AirportSummary = Readonly<{ id: string; artccId: string; lastUpdatedAt?: string | null }>
type ScenarioSummary = Readonly<{ id: string; name: string; artccId?: string | null; primaryAirportId?: string | null }>

export const VnasDataLive = Layer.effect(VnasData)(
  Effect.gen(function* () {
    const http = yield* HttpText
    const cache = yield* Ref.make(new Map<string, AirportFile>())
    const remember = (airport: AirportFile) =>
      Ref.update(cache, (m) => new Map(m).set(airport.id, airport)).pipe(Effect.map(() => airport))
    const cached = (id: string) =>
      Ref.get(cache).pipe(
        Effect.flatMap((m) => {
          const a = m.get(id)
          return a === undefined ? Effect.fail(new DataError({ message: `airport ${id} is not loaded` })) : Effect.succeed(a)
        }),
      )
    const vnas = (proxy: string, path: string) => getJson(http, viaProxy(proxy, `${API}${path}`))

    const catalogIndex = getJson(http, `${CATALOG_BASE}index.json`).pipe(Effect.flatMap(decode(CatalogIndex)))
    const catalogAirport = (id: string) => getJson(http, `${CATALOG_BASE}airports/${id}.json`).pipe(Effect.flatMap(decode(AirportFile)))

    const liveIndex = (proxy: string) =>
      Effect.gen(function* () {
        const [artccs, airports, scenarios] = yield* Effect.all([
          vnas(proxy, '/artcc-summaries') as Effect.Effect<ReadonlyArray<ArtccSummary>, HttpError | Error>,
          vnas(proxy, '/training/airport-summaries') as Effect.Effect<ReadonlyArray<AirportSummary>, HttpError | Error>,
          vnas(proxy, '/training/scenario-summaries') as Effect.Effect<ReadonlyArray<ScenarioSummary>, HttpError | Error>,
        ])
        const counts: Record<string, number> = {}
        for (const s of scenarios) {
          if (s.primaryAirportId) {
            counts[s.primaryAirportId] = (counts[s.primaryAirportId] ?? 0) + 1
          }
        }
        const names = Object.fromEntries(artccs.map((a) => [a.id, a.name ?? a.id]))
        const by: Record<string, Array<CatalogIndex['artccs'][number]['airports'][number]>> = {}
        for (const a of airports) {
          ;(by[a.artccId] ??= []).push({ id: a.id, name: a.id, n: counts[a.id] ?? 0, asdex: false, gates: 0, taxi: 0, stars: false })
        }
        return {
          built: '',
          artccs: Object.keys(by)
            .sort()
            .map((id) => ({ id, name: names[id] ?? id, airports: by[id]!.sort((x, y) => x.id.localeCompare(y.id)) })),
        } satisfies CatalogIndex
      })

    const liveAirport = (proxy: string, id: string, artcc: string) =>
      Effect.gen(function* () {
        const [artccDoc, apt, mapDoc, scenarios] = yield* Effect.all([
          vnas(proxy, `/artccs/${artcc}`) as Effect.Effect<ArtccDocument, HttpError | Error>,
          vnas(proxy, `/training/airports/${id}`) as Effect.Effect<VnasTrainingAirport, HttpError | Error>,
          vnas(proxy, `/training/airports/${id}/map`) as Effect.Effect<Parameters<typeof compactMap>[0], HttpError | Error>,
          vnas(proxy, '/training/scenario-summaries') as Effect.Effect<ReadonlyArray<ScenarioSummary>, HttpError | Error>,
        ])
        const scen: Array<Scenario> = scenarios
          .filter((s) => s.primaryAirportId === id)
          .map((s) => ({ id: s.id, name: s.name, stu: null, n: 0, air: 0, gen: [], ac: [] }))
          .sort((x, y) => x.name.localeCompare(y.name))
        const assembled = assembleAirport({ id, artcc, updated: null, facilityIndex: facilityIndex(artccDoc), airport: apt, map: compactMap(mapDoc), scen })
        return yield* decode(AirportFile)(assembled)
      })

    const liveScenario = (proxy: string, airport: AirportFile, scenarioId: string) =>
      Effect.gen(function* () {
        const [artccDoc, full] = yield* Effect.all([
          vnas(proxy, `/artccs/${airport.artcc}`) as Effect.Effect<ArtccDocument, HttpError | Error>,
          vnas(proxy, `/training/scenarios/${scenarioId}`) as Effect.Effect<VnasScenario, HttpError | Error>,
        ])
        const compact = compactScenario(full, facilityIndex(artccDoc).positions)
        return (
          scenarioForAirport(compact, airport.id) ?? {
            id: scenarioId,
            name: full.name,
            stu: compact.stu,
            n: compact.n,
            air: compact.air,
            gen: compact.gen,
            ac: [],
          }
        )
      })

    return {
      index: (source) =>
        DataSource.match(source, {
          Catalog: () => catalogIndex,
          Live: ({ proxy }) => liveIndex(proxy),
        }).pipe(Effect.mapError(toDataError)),
      airport: (source, id, artcc) =>
        DataSource.match(source, {
          Catalog: () => catalogAirport(id),
          Live: ({ proxy }) => liveAirport(proxy, id, artcc),
        }).pipe(Effect.mapError(toDataError), Effect.flatMap(remember)),
      scenario: (source, airportId, scenarioId) =>
        cached(airportId).pipe(
          Effect.flatMap((airport) => {
            const inline = airport.scen.find((s) => s.id === scenarioId)
            if (inline === undefined) {
              return Effect.fail(new DataError({ message: `no scenario ${scenarioId} at ${airportId}` }))
            }
            return DataSource.match(source, {
              Catalog: () => Effect.succeed(inline),
              Live: ({ proxy }) => liveScenario(proxy, airport, scenarioId).pipe(Effect.mapError(toDataError)),
            })
          }),
        ),
    } satisfies VnasDataShape
  }),
)
