/**
 * Builds catalog/ from the vNAS data API (docs/REWRITE.md section 6).
 *
 * Why a build step: vNAS serves /api/* without an Access-Control-Allow-Origin
 * header, so a page cannot read training airports or scenarios directly. This
 * script runs under Bun, where CORS does not apply, and bakes everything the
 * page needs into static JSON validated against src/domain/catalog.ts.
 *
 *   bun run catalog              # every ARTCC
 *   bun run catalog ZMP ZLA      # just these
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Schema } from 'effect'

import { AirportFile, ArtccFile, type CatalogIndex, decodeCatalogIndex } from '../src/domain/catalog'
import { NAV_MARGIN_NM, decodeNavData, navForAirport, navForArtcc } from '../src/domain/navdata'
import { API, FILES, type ArtccDocument, type CompactScenario, type FacilityIndex, type GeoJson, type VnasScenario, type VnasTrainingAirport, assembleAirport, assembleArtcc, compactMap, compactScenario, facilityIndex, parseLenientJSON, scenarioForAirport } from '../src/domain/vnas'

const OUT = new URL('../catalog/', import.meta.url)
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase())
const CONCURRENCY = Number(process.env['CONCURRENCY'] ?? 8)

const get = async <T>(path: string, tries = 3): Promise<T | null> => {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } })
      if (r.status === 404) {
        return null
      }
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`)
      }
      return parseLenientJSON(await r.text()) as T
    } catch (e) {
      if (i >= tries) {
        throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`)
      }
      await new Promise((res) => setTimeout(res, 800 * i))
    }
  }
}

const pool = async <A, B>(items: ReadonlyArray<A>, n: number, fn: (item: A, i: number) => Promise<B>): Promise<Array<B>> => {
  const out = new Array<B>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const k = next++
        out[k] = await fn(items[k]!, k)
      }
    }),
  )
  return out
}

type ArtccSummary = Readonly<{ id: string; name?: string | null }>
type AirportSummary = Readonly<{ id: string; artccId: string; lastUpdatedAt?: string | null }>
type ScenarioSummary = Readonly<{ id: string; name: string; artccId?: string | null }>

await mkdir(new URL('airports/', OUT), { recursive: true })
await mkdir(new URL('artccs/', OUT), { recursive: true })

const [artccSummaries, airportSummaries, scenarioSummaries] = await Promise.all([
  get<ReadonlyArray<ArtccSummary>>('/artcc-summaries'),
  get<ReadonlyArray<AirportSummary>>('/training/airport-summaries'),
  get<ReadonlyArray<ScenarioSummary>>('/training/scenario-summaries'),
])
if (!artccSummaries || !airportSummaries || !scenarioSummaries) {
  throw new Error('vNAS summaries unavailable')
}
const artccName = Object.fromEntries(artccSummaries.map((s) => [s.id, s.name ?? s.id]))

/** NavData.dat: fixes for fix-radial-distance starts and the per-airport nav blocks (Phase 8). */
const navResponse = await fetch(`${FILES}/NavData.dat`)
if (!navResponse.ok) {
  throw new Error(`NavData.dat: HTTP ${navResponse.status}`)
}
const nav = decodeNavData(new Uint8Array(await navResponse.arrayBuffer()))
console.log(`NavData: ${nav.fixes.size} fixes, ${nav.airports.size} airports, ${nav.stars.length} STARs, ${nav.sids.length} SIDs`)

const airports = wanted.length > 0 ? airportSummaries.filter((a) => wanted.includes(a.artccId)) : airportSummaries
const artccIds = [...new Set(airports.map((a) => a.artccId))].sort()
console.log(`${airports.length} training airports across ${artccIds.length} ARTCC(s)`)

const facIndex: Record<string, FacilityIndex> = {}
/** ARTCC files (Phase 9): the ERAM GeoMaps, sectors and centre positions, with the en-route nav across the ARTCC. */
const eram: Record<string, boolean> = {}
const validateArtcc = Schema.decodeUnknownSync(ArtccFile)
await pool(artccIds, 4, async (id) => {
  const doc = await get<ArtccDocument>(`/artccs/${id}`)
  facIndex[id] = facilityIndex(doc)
  const artcc = assembleArtcc({ id, name: artccName[id] ?? id, document: doc, nav: navForArtcc(nav, id) })
  validateArtcc(artcc)
  await writeFile(new URL(`artccs/${id}.json`, OUT), JSON.stringify(artcc))
  eram[id] = artcc.geoMaps.length > 0
  console.log(
    `  ${id}: ${Object.keys(facIndex[id]!.facilities).length} facilities, ${artcc.geoMaps.length} GeoMaps (${artcc.geoMaps.reduce((n, g) => n + g.maps.length, 0)} maps), ${artcc.sectors.length} sectors, ${Object.keys(artcc.nav.fixes).length} fixes, ${Object.keys(artcc.nav.airways ?? {}).length} airways within ${artcc.rangeNm} nm`,
  )
})

const scenList = scenarioSummaries.filter((s) => s.artccId !== null && s.artccId !== undefined && artccIds.includes(s.artccId))
console.log(`fetching ${scenList.length} scenarios…`)
let done = 0
const compact = await pool(scenList, CONCURRENCY, async (s): Promise<CompactScenario | null> => {
  const doc = await get<VnasScenario>(`/training/scenarios/${s.id}`)
  if (++done % 200 === 0) {
    console.log(`  ${done}/${scenList.length}`)
  }
  return doc ? compactScenario(doc, facIndex[s.artccId!]?.positions ?? {}, nav.fixes) : null
})

const index: Record<string, Array<CatalogIndex['artccs'][number]['airports'][number]>> = {}
const validate = Schema.decodeUnknownSync(AirportFile)
await pool(airports, CONCURRENCY, async (a) => {
  let apt: VnasTrainingAirport | null
  let mapDoc: GeoJson | null
  try {
    ;[apt, mapDoc] = await Promise.all([get<VnasTrainingAirport>(`/training/airports/${a.id}`), get<GeoJson>(`/training/airports/${a.id}/map`)])
  } catch (e) {
    console.log(`  ${a.id}: ${e instanceof Error ? e.message : String(e)} — skipped`)
    return
  }
  if (!mapDoc) {
    console.log(`  ${a.id}: no map, skipped`)
    return
  }
  const map = compactMap(mapDoc)
  if (map.rwy.length === 0) {
    console.log(`  ${a.id}: map has no runways, skipped`)
    return
  }
  const scen = compact
    .flatMap((c) => (c === null ? [] : [scenarioForAirport(c, a.id)]))
    .flatMap((s) => (s === null ? [] : [s]))
    .sort((x, y) => x.name.localeCompare(y.name))
  const assembled = assembleAirport({
    id: a.id,
    artcc: a.artccId,
    updated: a.lastUpdatedAt ?? null,
    facilityIndex: facIndex[a.artccId] ?? null,
    airport: apt,
    map,
    scen,
    elevation: nav.airports.get(a.id)?.elevation ?? null,
  })
  const navCenter = assembled.stars?.center ?? assembled.tower ?? nav.airports.get(a.id)?.c ?? null
  const doc: AirportFile =
    navCenter === null ? assembled : { ...assembled, nav: navForAirport(nav, navCenter, (assembled.stars?.range ?? 40) + NAV_MARGIN_NM) }
  try {
    validate(doc)
  } catch (e) {
    console.log(`  ${a.id}: does not match the schema — skipped: ${String(e).split('\n')[0]}`)
    return
  }
  await writeFile(new URL(`airports/${a.id}.json`, OUT), JSON.stringify(doc))
  ;(index[a.artccId] ??= []).push({ id: a.id, name: doc.name, n: scen.length, asdex: doc.asdex !== null, gates: Object.keys(map.park).length, taxi: map.taxi.length, stars: doc.stars !== null })
  console.log(
    `  ${a.id.padEnd(4)} ${doc.name.padEnd(34)} ${String(scen.length).padStart(3)} scenarios  ${String(map.taxi.length).padStart(3)} taxiways  ${String(Object.keys(map.park).length).padStart(3)} gates${doc.asdex ? '  ASDE-X' : ''}${
      doc.stars ? `  STARS ${doc.stars.host} ${doc.stars.def.length} maps${doc.stars.dep ? ' dep ' + doc.stars.dep.freq : ''}` : ''
    }${doc.nav ? `  nav ${Object.keys(doc.nav.fixes).length} fixes ${Object.keys(doc.nav.stars).length} STARs` : ''}`,
  )
})

/** A partial build keeps the other ARTCCs' entries from the index already on disk. */
const previous: CatalogIndex | null =
  wanted.length > 0
    ? await readFile(new URL('index.json', OUT), 'utf8')
        .then((text) => decodeCatalogIndex(JSON.parse(text)))
        .catch(() => null)
    : null
const kept = (previous?.artccs ?? []).filter((a) => !artccIds.includes(a.id))
const built = Object.keys(index).map((id) => ({ id, name: artccName[id] ?? id, airports: index[id]!.sort((a, b) => a.id.localeCompare(b.id)), eram: eram[id] === true }))
const artccs = [...kept, ...built].sort((a, b) => a.id.localeCompare(b.id))
await writeFile(new URL('index.json', OUT), JSON.stringify({ built: new Date().toISOString(), artccs }))
console.log(
  `\nWrote catalog/index.json (${artccs.length} ARTCCs${kept.length > 0 ? `, ${kept.length} kept from the previous index` : ''}) + ${built.reduce((n, a) => n + a.airports.length, 0)} airport files.`,
)
