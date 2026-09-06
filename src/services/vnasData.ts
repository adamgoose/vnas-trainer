/**
 * Airports and scenarios, from the baked catalog (default) or live from vNAS
 * through a user-run CORS proxy. Both layers decode through the catalog schemas.
 */
import { Context, Data, Effect, Layer, Schema } from 'effect'

import { AirportFile, CatalogIndex, type Scenario } from '../domain/catalog'
import { API, type ArtccDocument, type VnasScenario, type VnasTrainingAirport, assembleAirport, compactMap, compactScenario, facilityIndex, parseLenientJSON, scenarioForAirport } from '../domain/vnas'
import { HttpError, HttpText } from './http'

export class DataError extends Data.TaggedError('DataError')<{ message: string }> {}

export type VnasDataShape = Readonly<{
  /** where the data comes from, for the UI */
  source: 'catalog' | 'live'
  index: Effect.Effect<CatalogIndex, DataError>
  airport: (id: string, artcc: string) => Effect.Effect<AirportFile, DataError>
  /** the full scenario; the catalog has it inline, live mode fetches it */
  scenario: (airport: AirportFile, id: string) => Effect.Effect<Scenario, DataError>
}>

export class VnasData extends Context.Service<VnasData, VnasDataShape>()('VnasData') {}

const toDataError = (e: HttpError | Schema.SchemaError | Error): DataError =>
  new DataError({ message: e instanceof HttpError ? `${e.message} for ${e.url.split('?').pop()?.slice(0, 80)}` : String(e.message ?? e) })

const getJson = (url: string) =>
  Effect.gen(function* () {
    const http = yield* HttpText
    const text = yield* http.get(url)
    return yield* Effect.try({ try: () => parseLenientJSON(text), catch: (e) => new Error(`bad JSON from ${url}: ${String(e)}`) })
  })

const decode =
  <A>(schema: Schema.Codec<A, any, never, never>) =>
  (json: unknown) =>
    Schema.decodeUnknownEffect(schema)(json)

const inlineScenario = (airport: AirportFile, id: string): Effect.Effect<Scenario, DataError> => {
  const s = airport.scen.find((x) => x.id === id)
  return s === undefined ? Effect.fail(new DataError({ message: `no scenario ${id} at ${airport.id}` })) : Effect.succeed(s)
}

/** Reads `catalog/index.json` and `catalog/airports/{APT}.json` relative to the page. */
export const VnasDataCatalog = (base = 'catalog/') =>
  Layer.effect(VnasData)(
    Effect.gen(function* () {
      const http = yield* HttpText
      const provided = <A, E>(e: Effect.Effect<A, E, HttpText>) => Effect.provideService(e, HttpText, http)
      return {
        source: 'catalog',
        index: provided(getJson(`${base}index.json`).pipe(Effect.flatMap(decode(CatalogIndex)), Effect.mapError(toDataError))),
        airport: (id) =>
          provided(getJson(`${base}airports/${id}.json`).pipe(Effect.flatMap(decode(AirportFile)), Effect.mapError(toDataError))),
        scenario: inlineScenario,
      } satisfies VnasDataShape
    }),
  )

export const viaProxy = (proxy: string, url: string): string =>
  proxy.includes('{url}') ? proxy.replace('{url}', encodeURIComponent(url)) : proxy + encodeURIComponent(url)

type ArtccSummary = Readonly<{ id: string; name?: string | null }>
type AirportSummary = Readonly<{ id: string; artccId: string; lastUpdatedAt?: string | null }>
type ScenarioSummary = Readonly<{ id: string; name: string; artccId?: string | null; primaryAirportId?: string | null }>

/** Fetches vNAS through a CORS proxy and compacts on the fly; scenarios load on demand. */
export const VnasDataLive = (proxy: string) =>
  Layer.effect(VnasData)(
    Effect.gen(function* () {
      const http = yield* HttpText
      const vnas = (path: string) => getJson(viaProxy(proxy, `${API}${path}`)).pipe(Effect.provideService(HttpText, http))
      const index: Effect.Effect<CatalogIndex, DataError> = Effect.gen(function* () {
        const [artccs, airports, scenarios] = yield* Effect.all([
          vnas('/artcc-summaries') as Effect.Effect<ReadonlyArray<ArtccSummary>, HttpError | Error>,
          vnas('/training/airport-summaries') as Effect.Effect<ReadonlyArray<AirportSummary>, HttpError | Error>,
          vnas('/training/scenario-summaries') as Effect.Effect<ReadonlyArray<ScenarioSummary>, HttpError | Error>,
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
        }
      }).pipe(Effect.mapError(toDataError))
      const airport = (id: string, artcc: string): Effect.Effect<AirportFile, DataError> =>
        Effect.gen(function* () {
          const [artccDoc, apt, mapDoc, scenarios] = yield* Effect.all([
            vnas(`/artccs/${artcc}`) as Effect.Effect<ArtccDocument, HttpError | Error>,
            vnas(`/training/airports/${id}`) as Effect.Effect<VnasTrainingAirport, HttpError | Error>,
            vnas(`/training/airports/${id}/map`) as Effect.Effect<Parameters<typeof compactMap>[0], HttpError | Error>,
            vnas('/training/scenario-summaries') as Effect.Effect<ReadonlyArray<ScenarioSummary>, HttpError | Error>,
          ])
          const fi = facilityIndex(artccDoc)
          const scen: Array<Scenario> = scenarios
            .filter((s) => s.primaryAirportId === id)
            .map((s) => ({ id: s.id, name: s.name, stu: null, n: 0, air: 0, gen: [], ac: [] }))
            .sort((x, y) => x.name.localeCompare(y.name))
          const assembled = assembleAirport({ id, artcc, updated: null, facilityIndex: fi, airport: apt, map: compactMap(mapDoc), scen })
          return yield* decode(AirportFile)(assembled)
        }).pipe(Effect.mapError(toDataError))
      const scenario = (airportFile: AirportFile, scenarioId: string): Effect.Effect<Scenario, DataError> =>
        Effect.gen(function* () {
          const [artccDoc, full] = yield* Effect.all([
            vnas(`/artccs/${airportFile.artcc}`) as Effect.Effect<ArtccDocument, HttpError | Error>,
            vnas(`/training/scenarios/${scenarioId}`) as Effect.Effect<VnasScenario, HttpError | Error>,
          ])
          const compact = compactScenario(full, facilityIndex(artccDoc).positions)
          return (
            scenarioForAirport(compact, airportFile.id) ?? {
              id: scenarioId,
              name: full.name,
              stu: compact.stu,
              n: compact.n,
              air: compact.air,
              gen: compact.gen,
              ac: [],
            }
          )
        }).pipe(Effect.mapError(toDataError))
      return { source: 'live', index, airport, scenario } satisfies VnasDataShape
    }),
  )
