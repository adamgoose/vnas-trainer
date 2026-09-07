import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { readFileSync } from 'node:fs'

import { API, FILES } from '../src/domain/vnas'
import { HttpTextFromRecord } from '../src/services/http'
import { SettingsStore, SettingsStoreMemory, defaultSettings, mergeSettings } from '../src/services/settings'
import { VideoMaps, VideoMapsLive } from '../src/services/videoMaps'
import { DataSource, VnasData, VnasDataLive, sourceForProxy, viaProxy } from '../src/services/vnasData'

const mspText = readFileSync(new URL('./fixtures/MSP.json', import.meta.url), 'utf8')
const indexText = JSON.stringify({ built: '2026-09-06T00:00:00Z', artccs: [{ id: 'ZMP', name: 'Minneapolis ARTCC', airports: [{ id: 'MSP', name: 'Minneapolis ATCT', n: 64, asdex: true, gates: 220, taxi: 106, stars: true }] }] })

describe('VnasData, catalog source', () => {
  const http = HttpTextFromRecord({ 'catalog/index.json': indexText, 'catalog/airports/MSP.json': mspText })
  const runWith = <A, E>(e: Effect.Effect<A, E, VnasData>) => Effect.runPromise(e.pipe(Effect.provide(VnasDataLive), Effect.provide(http)))
  const catalog = DataSource.Catalog()

  test('decodes the index and an airport, and finds inline scenarios from the cache', async () => {
    const out = await runWith(
      Effect.gen(function* () {
        const data = yield* VnasData
        const index = yield* data.index(catalog)
        const airport = yield* data.airport(catalog, 'MSP', 'ZMP')
        const scenario = yield* data.scenario(catalog, 'MSP', airport.scen[0]!.id)
        return { artccs: index.artccs.length, id: airport.id, scenarios: airport.scen.length, first: scenario.name }
      }),
    )
    expect(out).toEqual({ artccs: 1, id: 'MSP', scenarios: 80, first: 'Ancient MSP APP North' })
  })

  test('reports missing files, bad shapes and unloaded airports as DataError', async () => {
    const missing = await runWith(Effect.gen(function* () { return yield* (yield* VnasData).airport(catalog, 'ZZZ', 'ZMP') }).pipe(Effect.flip))
    expect(missing._tag).toBe('DataError')
    expect(missing.message).toContain('HTTP 404')
    const unloaded = await runWith(Effect.gen(function* () { return yield* (yield* VnasData).scenario(catalog, 'MSP', 'x') }).pipe(Effect.flip))
    expect(unloaded.message).toBe('airport MSP is not loaded')
    const bad = HttpTextFromRecord({ 'catalog/index.json': '{"built": 1}' })
    const shape = await Effect.runPromise(
      Effect.gen(function* () { return yield* (yield* VnasData).index(catalog) }).pipe(Effect.flip, Effect.provide(VnasDataLive), Effect.provide(bad)),
    )
    expect(shape._tag).toBe('DataError')
  })
})

describe('VnasData, live source', () => {
  const proxy = 'https://proxy.example/?url='
  const live = DataSource.Live({ proxy })
  const u = (path: string) => viaProxy(proxy, `${API}${path}`)
  const artcc = {
    facility: { id: 'ZMP', name: 'Minneapolis ARTCC', childFacilities: [{ id: 'MSP', name: 'Minneapolis ATCT', positions: [{ id: 'p1', callsign: 'MSP_S_GND' }] }] },
    videoMaps: [],
  }
  const http = HttpTextFromRecord({
    [u('/artcc-summaries')]: JSON.stringify([{ id: 'ZMP', name: 'Minneapolis ARTCC' }]),
    [u('/training/airport-summaries')]: JSON.stringify([{ id: 'MSP', artccId: 'ZMP' }, { id: 'ANE', artccId: 'ZMP' }]),
    [u('/training/scenario-summaries')]: JSON.stringify([{ id: 's1', name: 'One', artccId: 'ZMP', primaryAirportId: 'MSP' }, { id: 's2', name: 'Two', artccId: 'ZMP', primaryAirportId: 'MSP' }]),
    [u('/artccs/ZMP')]: JSON.stringify(artcc),
    [u('/training/airports/MSP')]: JSON.stringify({ jetInitialAltitude: 7000, propInitialAltitude: 5000, patternAltitude: 1800, trainingAircraftSets: [] }),
    [u('/training/airports/MSP/map')]: '// comment\n' + JSON.stringify({ features: [{ properties: { type: 'runway', name: '12R-30L' }, geometry: { type: 'LineString', coordinates: [[-93.23, 44.88], [-93.2, 44.87]] } }, { properties: { type: 'parking', name: 'E16', heading: 30 }, geometry: { type: 'Point', coordinates: [-93.21, 44.875] } }] }),
    [u('/training/scenarios/s1')]: JSON.stringify({ id: 's1', name: 'One', primaryAirportId: 'MSP', studentPositionId: 'p1', aircraft: [{ aircraftId: 'AAL1', startingConditions: { type: 'Parking', parking: 'E16' }, flightplan: { aircraftType: 'B738/L' } }] }),
  })
  const runWith = <A, E>(e: Effect.Effect<A, E, VnasData>) => Effect.runPromise(e.pipe(Effect.provide(VnasDataLive), Effect.provide(http)))

  test('builds the index and the airport file from vNAS documents and resolves scenarios lazily', async () => {
    const out = await runWith(
      Effect.gen(function* () {
        const data = yield* VnasData
        const index = yield* data.index(live)
        const airport = yield* data.airport(live, 'MSP', 'ZMP')
        const scenario = yield* data.scenario(live, 'MSP', 's1')
        return { index, airport, scenario }
      }),
    )
    expect(out.index.artccs[0]!.airports.map((a) => [a.id, a.n])).toEqual([['ANE', 0], ['MSP', 2]])
    expect(out.airport).toMatchObject({ id: 'MSP', artcc: 'ZMP', name: 'Minneapolis ATCT', init: { jet: 7000, prop: 5000, pattern: 1800 } })
    expect(out.airport.map.rwy[0]!.n).toBe('12R-30L')
    expect(out.airport.scen.map((s) => [s.name, s.ac.length])).toEqual([['One', 0], ['Two', 0]])
    expect(out.scenario).toMatchObject({ id: 's1', name: 'One', stu: 'MSP_S_GND', n: 1, ac: [{ cs: 'AAL1', ty: 'B738', k: 'P', at: 'E16' }] })
  })

  test('proxy templates accept a {url} placeholder or a prefix; an empty proxy means the catalog', () => {
    expect(viaProxy('https://p/?url=', 'https://a/b c')).toBe('https://p/?url=https%3A%2F%2Fa%2Fb%20c')
    expect(viaProxy('https://p/{url}/x', 'https://a/b')).toBe('https://p/https%3A%2F%2Fa%2Fb/x')
    expect(sourceForProxy('  ')).toEqual(DataSource.Catalog())
    expect(sourceForProxy(' https://p/?url= ')).toEqual(DataSource.Live({ proxy: 'https://p/?url=' }))
  })
})

describe('VideoMaps', () => {
  test('fetches and parses a map through the Files endpoint', async () => {
    const http = HttpTextFromRecord({
      [`${FILES}/VideoMaps/ZMP/abc.geojson`]: JSON.stringify({ features: [{ properties: { asdex: 'runway' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1]]] } }] }),
    })
    const map = await Effect.runPromise(
      Effect.gen(function* () { return yield* (yield* VideoMaps).load('ZMP', 'abc') }).pipe(Effect.provide(VideoMapsLive), Effect.provide(http)),
    )
    expect(map.id).toBe('abc')
    expect(map.features[0]!.asdex).toBe('runway')
    const failed = await Effect.runPromise(
      Effect.gen(function* () { return yield* (yield* VideoMaps).load('ZMP', 'nope') }).pipe(Effect.flip, Effect.provide(VideoMapsLive), Effect.provide(http)),
    )
    expect(failed._tag).toBe('DataError')
  })
})

describe('Settings', () => {
  test('merges stored values over defaults and ignores bad ones', () => {
    expect(mergeSettings(null)).toEqual(defaultSettings)
    expect(mergeSettings({ key: 'abc', mode: 'tower', tts: 'yes', ttsEngine: 'nope', view: 'stars' })).toEqual({ ...defaultSettings, key: 'abc', mode: 'tower', view: 'stars' })
  })

  test('round-trips through a storage under the legacy key', async () => {
    const layer = SettingsStoreMemory({ 'vgt.settings': JSON.stringify({ key: 'k', model: 'm', radio: false }) })
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SettingsStore
        const loaded = yield* store.load
        yield* store.save({ ...loaded, proxy: 'https://p/?url=' })
        return { loaded, saved: yield* store.load }
      }).pipe(Effect.provide(layer)),
    )
    expect(out.loaded).toEqual({ ...defaultSettings, key: 'k', model: 'm', radio: false })
    expect(out.saved.proxy).toBe('https://p/?url=')
  })
})
