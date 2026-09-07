/**
 * Pure transforms from vNAS training data into the compact catalog shapes
 * (docs/REWRITE.md section 6). Used by the catalog builder (Bun) and by the
 * app's live mode (browser via a CORS proxy). Port of legacy/lib/vnas.mjs.
 */
import type { AirportFile, AirportMap, AirportNav, FleetEntry, LonLat, ParkingSpot, Scenario, ScenarioAircraft, Stars } from './catalog'
import { resolveFixOrFrd } from './navdata'

export const API = 'https://data-api.vnas.vatsim.net/api'
export const FILES = 'https://data-api.vnas.vatsim.net/Files'

/**
 * Airport maps are hand-edited GeoJSON and a few are not strictly valid JSON:
 * `//` comment lines, trailing commas, and headings written as `010`. Try the
 * strict parse first, then repair those three things and retry.
 */
export const parseLenientJSON = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    const fixed = text
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/([:[,]\s*-?)0+(\d)/g, '$1$2')
      .replace(/,\s*([\]}])/g, '$1')
    return JSON.parse(fixed)
  }
}

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6
const point = (c: ReadonlyArray<number>): LonLat => [r6(c[0] ?? 0), r6(c[1] ?? 0)]

/** "H/B744/L" -> "B744", "B738/L" -> "B738" */
export const aircraftType = (s: string | null | undefined): string => {
  const parts = (s ?? '').split('/').filter((p) => p.length > 0)
  const first = parts[0]
  if (first === undefined) {
    return ''
  }
  if (first.length <= 1 && parts.length > 1) {
    return parts[1]!
  }
  return first
}

// INPUT SHAPES (only the fields the trainer reads)

export type GeoJsonFeature = Readonly<{
  properties?: Readonly<Record<string, unknown>> | null
  geometry?: Readonly<{ type?: string; coordinates?: unknown }> | null
}>
export type GeoJson = Readonly<{ features?: ReadonlyArray<GeoJsonFeature> | null }>

const asString = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))

/** Training-map GeoJSON -> compact map used by the graph builder. */
export const compactMap = (geojson: GeoJson): AirportMap => {
  const taxi: Array<{ n: string; c: Array<LonLat> }> = []
  const rwy: Array<{ n: string; c: Array<LonLat>; thr: string | null; to: string | null }> = []
  const park: Record<string, ParkingSpot> = {}
  const spot: Record<string, ParkingSpot> = {}
  for (const f of geojson.features ?? []) {
    const p = f.properties ?? {}
    const g = f.geometry ?? {}
    const t = asString(p['type']).toLowerCase()
    const name = asString(p['name']).trim()
    if (name === '') {
      continue
    }
    const coords = g.coordinates
    if (t === 'taxiway' && g.type === 'LineString' && Array.isArray(coords)) {
      taxi.push({ n: name.toUpperCase(), c: (coords as Array<ReadonlyArray<number>>).map(point) })
    } else if (t === 'runway' && g.type === 'LineString' && Array.isArray(coords)) {
      rwy.push({
        n: name.toUpperCase().replace(/\s+/g, ''),
        c: (coords as Array<ReadonlyArray<number>>).map(point),
        thr: p['threshold'] === undefined || p['threshold'] === null ? null : asString(p['threshold']),
        to: p['turnoff'] === undefined || p['turnoff'] === null ? null : asString(p['turnoff']),
      })
    } else if ((t === 'parking' || t === 'spot') && g.type === 'Point' && Array.isArray(coords)) {
      const heading = parseFloat(asString(p['heading']))
      const c = coords as ReadonlyArray<number>
      const rec: ParkingSpot = [r6(c[0] ?? 0), r6(c[1] ?? 0), Math.round(Number.isFinite(heading) ? heading : 0)]
      ;(t === 'parking' ? park : spot)[name.toUpperCase()] = rec
    }
  }
  return { taxi, rwy, park, spot }
}

export type VnasPosition = Readonly<{
  id: string
  callsign?: string | null
  name?: string | null
  radioName?: string | null
  frequency?: number | null
  starsConfiguration?: Readonly<{ tcpId?: string | null }> | null
}>
export type VnasFacility = Readonly<{
  id: string
  name?: string | null
  type?: string | null
  towerCabConfiguration?: Readonly<{ towerLocation?: Readonly<{ lon: number; lat: number }> | null; videoMapId?: string | null }> | null
  asdexConfiguration?: Readonly<{ videoMapId?: string | null }> | null
  starsConfiguration?: Readonly<{
    videoMapIds?: ReadonlyArray<string> | null
    mapGroups?: ReadonlyArray<Readonly<{ tcps?: ReadonlyArray<string> | null; mapIds?: ReadonlyArray<number | null> | null }>> | null
    tcps?: ReadonlyArray<Readonly<{ id: string; subset?: number | string | null; sectorId?: string | null }>> | null
    areas?: ReadonlyArray<Readonly<{ name?: string | null; visibilityCenter?: Readonly<{ lon: number; lat: number }> | null; surveillanceRange?: number | null }>> | null
  }> | null
  positions?: ReadonlyArray<VnasPosition> | null
  childFacilities?: ReadonlyArray<VnasFacility> | null
}>
export type VnasVideoMap = Readonly<{
  id: string
  name?: string | null
  shortName?: string | null
  starsId?: number | null
  starsBrightnessCategory?: string | null
  starsAlwaysVisible?: boolean | null
  tdmOnly?: boolean | null
  tags?: ReadonlyArray<string> | null
}>
export type ArtccDocument = Readonly<{ facility?: VnasFacility | null; videoMaps?: ReadonlyArray<VnasVideoMap> | null }>

export type IndexedPosition = Readonly<{
  id: string
  cs: string | null
  name: string | null
  radio: string | null
  freq: number | null
  tcpId: string | null
}>
export type IndexedFacility = Readonly<{
  id: string
  name: string
  type: string | null
  parent: string | null
  tower: LonLat | null
  asdex: string | null
  twrmap: string | null
  starsMaps: ReadonlyArray<string> | null
  mapGroups: NonNullable<NonNullable<VnasFacility['starsConfiguration']>['mapGroups']> | null
  tcps: NonNullable<NonNullable<VnasFacility['starsConfiguration']>['tcps']> | null
  areas: NonNullable<NonNullable<VnasFacility['starsConfiguration']>['areas']> | null
  positions: ReadonlyArray<IndexedPosition>
}>
export type FacilityIndex = Readonly<{
  facilities: Readonly<Record<string, IndexedFacility>>
  positions: Readonly<Record<string, string>>
  videoMaps: Readonly<Record<string, VnasVideoMap>>
}>

/** ARTCC document -> facilities by id, position id -> callsign, video maps by id. */
export const facilityIndex = (artcc: ArtccDocument | null): FacilityIndex => {
  const facilities: Record<string, IndexedFacility> = {}
  const positions: Record<string, string> = {}
  const videoMaps: Record<string, VnasVideoMap> = {}
  for (const v of artcc?.videoMaps ?? []) {
    videoMaps[v.id] = v
  }
  const walk = (f: VnasFacility | null | undefined, parent: string | null) => {
    if (!f) {
      return
    }
    const loc = f.towerCabConfiguration?.towerLocation
    const sc = f.starsConfiguration ?? null
    facilities[f.id] = {
      id: f.id,
      name: f.name ?? f.id,
      type: f.type ?? null,
      parent,
      tower: loc ? [r6(loc.lon), r6(loc.lat)] : null,
      asdex: f.asdexConfiguration?.videoMapId ?? null,
      twrmap: f.towerCabConfiguration?.videoMapId ?? null,
      starsMaps: sc?.videoMapIds ?? null,
      mapGroups: sc?.mapGroups ?? null,
      tcps: sc?.tcps ?? null,
      areas: sc?.areas ?? null,
      positions: (f.positions ?? []).map((p) => ({
        id: p.id,
        cs: p.callsign ?? null,
        name: p.name ?? null,
        radio: p.radioName ?? null,
        freq: p.frequency ?? null,
        tcpId: p.starsConfiguration?.tcpId ?? null,
      })),
    }
    for (const p of f.positions ?? []) {
      positions[p.id] = p.callsign ?? p.name ?? p.id
    }
    for (const c of f.childFacilities ?? []) {
      walk(c, f.id)
    }
  }
  walk(artcc?.facility, null)
  return { facilities, positions, videoMaps }
}

/** 124700000 -> "124.700" */
export const formatFrequency = (hz: number | null | undefined): string | null =>
  hz ? (hz / 1e6).toFixed(3) : null

const positionRecord = (p: IndexedPosition) => ({
  cs: p.cs ?? '',
  name: p.name ?? '',
  radio: p.radio ?? '',
  freq: formatFrequency(p.freq) ?? '',
})

/**
 * The tower's STARS picture for an airport: the facility that runs the scope
 * (itself or an ancestor TRACON), its video maps, the default map group for the
 * tower position (position -> TCP -> map group, the chain CRC uses for the DCB),
 * the radar area centre/range, and the departure position to hand off to.
 */
export const starsForAirport = (fi: FacilityIndex, airportId: string): Stars | null => {
  const f = fi.facilities[airportId]
  if (f === undefined) {
    return null
  }
  let host: IndexedFacility | undefined = f
  while (host !== undefined && host.starsMaps === null) {
    host = host.parent !== null ? fi.facilities[host.parent] : undefined
  }
  if (host === undefined) {
    return null
  }
  const maps = (host.starsMaps ?? [])
    .map((id) => fi.videoMaps[id])
    .filter((v): v is VnasVideoMap => v !== undefined)
    .map((v) => ({
      id: v.id,
      sid: v.starsId ?? -1,
      sn: v.shortName ?? '',
      n: v.name ?? '',
      b: v.starsBrightnessCategory ?? 'A',
      av: v.starsAlwaysVisible === true,
      tdm: v.tdmOnly === true,
      tags: v.tags ?? [],
    }))
  const bySid = new Map(maps.filter((m) => m.sid >= 0).map((m) => [m.sid, m.id] as const))
  const tcpName = (t: Readonly<{ subset?: number | string | null; sectorId?: string | null }>) =>
    `${t.subset ?? ''}${t.sectorId ?? ''}`
  const twr = f.positions.find((p) => /_TWR$|_L_TWR|LOCAL|TOWER/i.test(`${p.cs ?? ''} ${p.name ?? ''}`)) ?? f.positions[0]
  let def: Array<string> = []
  let tcp: string | null = null
  if (twr?.tcpId) {
    const t = (host.tcps ?? []).find((x) => x.id === twr.tcpId)
    if (t !== undefined) {
      tcp = tcpName(t)
      const g = (host.mapGroups ?? []).find((x) => (x.tcps ?? []).includes(tcp!))
      if (g !== undefined) {
        def = [
          ...new Set(
            (g.mapIds ?? [])
              .filter((x): x is number => x !== null && x !== undefined)
              .map((sid) => bySid.get(sid))
              .filter((x): x is string => x !== undefined),
          ),
        ]
      }
    }
  }
  if (def.length === 0) {
    def = maps.filter((m) => m.av || m.tags.includes(airportId)).slice(0, 8).map((m) => m.id)
  }
  const area = (host.areas ?? []).find((a) => a.name === airportId) ?? (host.areas ?? [])[0] ?? null
  const vc = area?.visibilityCenter
  const center: LonLat | null = vc ? [r6(vc.lon), r6(vc.lat)] : f.tower
  if (center === null) {
    return null
  }
  const all = [...host.positions, ...f.positions]
  const dep =
    all.find((p) => /_DEP\b/i.test(p.cs ?? '') || /departure/i.test(p.radio ?? '') || /departure/i.test(p.name ?? '')) ??
    all.find((p) => /_APP\b/i.test(p.cs ?? '') || /approach/i.test(p.radio ?? ''))
  const app =
    all.find((p) => /_APP\b/i.test(p.cs ?? '') || /approach/i.test(p.radio ?? '') || /approach/i.test(p.name ?? '')) ?? dep
  let root: IndexedFacility = host
  while (root.parent !== null && fi.facilities[root.parent] !== undefined) {
    root = fi.facilities[root.parent]!
  }
  const ctr = root.positions.find((p) => /_CTR\b/i.test(p.cs ?? '') || /center/i.test(p.radio ?? ''))
  return {
    host: host.id,
    hostName: host.name,
    tcp,
    center,
    range: area?.surveillanceRange ?? 40,
    maps: maps.map(({ tags: _tags, ...m }) => m),
    def,
    ...(twr !== undefined ? { twr: positionRecord(twr) } : {}),
    dep: dep !== undefined ? positionRecord(dep) : null,
    app: app !== undefined ? positionRecord(app) : null,
    ctr: ctr !== undefined ? positionRecord(ctr) : null,
  }
}

/** "ZMBRO7 ODI J30 …" -> "ZMBRO7"; "ZMBRO7.ODI …" too. Airways (J30, Q82, T295) never match. */
export const sidFromRoute = (route: string | null | undefined): string | null => {
  const t = (route ?? '').trim().split(/\s+/)[0] ?? ''
  const m = /^([A-Z]{2,5}\d)(?:\.[A-Z0-9]+)?$/.exec(t)
  return m ? m[1]! : null
}

const AIRWAY = /^[JQVT]\d+$/

/** The SID's transition: "ZMBRO7 ODI J30 …" and "ZMBRO7.ODI …" -> "ODI"; null when the route joins an airway or has none. */
export const sidTransitionFromRoute = (route: string | null | undefined): string | null => {
  const tokens = (route ?? '').trim().split(/\s+/)
  const first = tokens[0] ?? ''
  if (sidFromRoute(first) === null) {
    return null
  }
  const dotted = /^[A-Z]{2,5}\d\.([A-Z0-9]+)$/.exec(first)
  if (dotted !== null) {
    return dotted[1]!
  }
  const next = tokens[1] ?? ''
  return /^[A-Z]{2,5}$/.test(next) && !AIRWAY.test(next) ? next : null
}

/** "ZMBRO7.ODI" for the data block: the SID with its transition when the route names one. */
export const departureProcedure = (sid: string | null, route: string | null | undefined): string | null => {
  if (sid === null) {
    return null
  }
  const transition = sidTransitionFromRoute(route)
  return transition === null ? sid : `${sid}.${transition}`
}

/** "… CVE DRLLR5" -> "DRLLR5" */
export const starFromRoute = (route: string | null | undefined): string | null => {
  const tokens = (route ?? '').trim().split(/\s+/)
  const t = tokens[tokens.length - 1] ?? ''
  const m = /^(?:[A-Z0-9]+\.)?([A-Z]{2,5}\d)$/.exec(t)
  return m && tokens.length > 1 ? m[1]! : null
}

export type VnasScenarioAircraft = Readonly<{
  aircraftId: string
  aircraftType?: string | null
  airportId?: string | null
  spawnDelay?: number | null
  expectedApproach?: string | null
  startingConditions?: Readonly<{
    type?: string | null
    parking?: string | null
    runway?: string | null
    distanceFromRunway?: number | null
    coordinates?: Readonly<{ lat: number; lon: number }> | null
    fix?: string | null
    altitude?: number | null
    speed?: number | null
    heading?: number | null
    navigationPath?: string | null
  }> | null
  flightplan?: Readonly<{
    aircraftType?: string | null
    route?: string | null
    departure?: string | null
    destination?: string | null
    rules?: string | null
    cruiseAltitude?: number | null
    cruiseSpeed?: number | null
    remarks?: string | null
  }> | null
}>
export type VnasScenario = Readonly<{
  id: string
  name: string
  primaryAirportId?: string | null
  studentPositionId?: string | null
  aircraft?: ReadonlyArray<VnasScenarioAircraft> | null
  aircraftGenerators?: ReadonlyArray<Readonly<{ runway?: string | null }>> | null
}>

export type CompactScenario = Readonly<{
  id: string
  name: string
  stu: string | null
  n: number
  air: number
  gen: ReadonlyArray<string>
  byAirport: Readonly<Record<string, ReadonlyArray<ScenarioAircraft>>>
}>

/**
 * Full scenario -> compact record with the aircraft grouped by airport. Airborne
 * aircraft (Coordinates / FixOrFrd starts) are counted in `air` and become spawn
 * kind A when they have an altitude and, for a fix start, the fix is in `fixes`.
 */
export const compactScenario = (
  scn: VnasScenario,
  positions: Readonly<Record<string, string>> = {},
  fixes: ReadonlyMap<string, LonLat> | Readonly<Record<string, LonLat>> = {},
): CompactScenario => {
  const byAirport: Record<string, Array<ScenarioAircraft>> = {}
  const queue: Record<string, number> = {}
  let air = 0
  for (const a of scn.aircraft ?? []) {
    const sc = a.startingConditions ?? {}
    const apt = (a.airportId ?? scn.primaryAirportId ?? '').toUpperCase()
    const fp = a.flightplan ?? {}
    const route = (fp.route ?? '').trim()
    const base = {
      cs: a.aircraftId,
      ty: aircraftType(a.aircraftType ?? fp.aircraftType),
      d: a.spawnDelay ?? 0,
      dep: fp.departure ?? null,
      dst: fp.destination ?? null,
      r: (fp.rules ?? 'I')[0] ?? 'I',
      ...(fp.aircraftType ? { tyf: fp.aircraftType } : {}),
      ...(route ? { rte: route } : {}),
      ...(fp.cruiseAltitude ? { alt: fp.cruiseAltitude } : {}),
      ...(fp.cruiseSpeed ? { spd: fp.cruiseSpeed } : {}),
      ...(fp.remarks ? { rmk: String(fp.remarks).trim() } : {}),
    }
    const sid = sidFromRoute(route)
    const star = starFromRoute(route)
    const withSid = { ...base, ...(sid ? { sid } : {}), ...(star ? { star } : {}), ...(a.expectedApproach ? { app: a.expectedApproach } : {}) }
    let rec: ScenarioAircraft | null = null
    if (sc.type === 'Parking') {
      rec = { ...withSid, k: 'P', at: (sc.parking ?? '').toUpperCase() }
    } else if (sc.type === 'OnRunway') {
      const rw = (sc.runway ?? '').toUpperCase()
      const key = `${apt}/${rw}`
      const q = queue[key] ?? 0
      queue[key] = q + 1
      rec = { ...withSid, k: 'R', at: rw, q }
    } else if (sc.type === 'OnFinal') {
      rec = { ...withSid, k: 'F', at: (sc.runway ?? '').toUpperCase(), nm: sc.distanceFromRunway ?? 5 }
    } else if (sc.type === 'Coordinates' || sc.type === 'FixOrFrd') {
      air++
      const c = sc.coordinates
      const pos: LonLat | null =
        sc.type === 'Coordinates' ? (c ? [r6(c.lon), r6(c.lat)] : null) : resolveFixOrFrd(fixes, sc.fix ?? '')
      if (pos === null || !sc.altitude) {
        continue
      }
      rec = {
        ...withSid,
        k: 'A',
        at: (sc.fix ?? '').toUpperCase(),
        pos,
        fa: sc.altitude,
        ias: sc.speed || 250,
        ...(sc.heading !== null && sc.heading !== undefined ? { hdg: sc.heading } : {}),
        ...(sc.navigationPath ? { nav: sc.navigationPath.trim().toUpperCase() } : {}),
      }
    } else {
      continue
    }
    if (apt === '') {
      continue
    }
    ;(byAirport[apt] ??= []).push(rec)
  }
  const gen = [...new Set((scn.aircraftGenerators ?? []).map((g) => (g.runway ?? '').toUpperCase()).filter((r) => r !== ''))]
  return {
    id: scn.id,
    name: scn.name,
    stu: scn.studentPositionId !== null && scn.studentPositionId !== undefined ? (positions[scn.studentPositionId] ?? null) : null,
    n: (scn.aircraft ?? []).length,
    air,
    gen,
    byAirport,
  }
}

/** Build the per-airport scenario entry the app consumes, or null when the scenario has no surface aircraft there. */
export const scenarioForAirport = (compact: CompactScenario, airportId: string): Scenario | null => {
  const ac = compact.byAirport[airportId]
  if (ac === undefined || ac.length === 0) {
    return null
  }
  return { id: compact.id, name: compact.name, stu: compact.stu, n: compact.n, air: compact.air, gen: compact.gen, ac }
}

export type VnasTrainingAirport = Readonly<{
  jetInitialAltitude?: number | null
  propInitialAltitude?: number | null
  patternAltitude?: number | null
  trainingAircraftSets?: ReadonlyArray<Readonly<{ airlineIcaoCode?: string | null; weight?: number | null; aircraftTypeCodes?: ReadonlyArray<string> | null }>> | null
}>

export const compactFleet = (apt: VnasTrainingAirport | null): ReadonlyArray<FleetEntry> =>
  (apt?.trainingAircraftSets ?? []).map((s) => ({ a: s.airlineIcaoCode ?? 'N', w: s.weight || 1, t: s.aircraftTypeCodes ?? [] }))

export const DEFAULT_INITIAL_ALTITUDE = 5000

/** Assemble an airport file from its vNAS pieces; `scen` is supplied by the caller. */
export const assembleAirport = (
  input: Readonly<{
    id: string
    artcc: string
    updated: string | null
    facilityIndex: FacilityIndex | null
    airport: VnasTrainingAirport | null
    map: AirportMap
    scen: ReadonlyArray<Scenario>
    nav?: AirportNav | null
    elevation?: number | null
  }>,
): AirportFile => {
  const fac = input.facilityIndex?.facilities[input.id]
  return {
    ...(input.nav ? { nav: input.nav } : {}),
    ...(input.elevation !== null && input.elevation !== undefined ? { elev: Math.round(input.elevation) } : {}),
    id: input.id,
    artcc: input.artcc,
    name: fac?.name ?? input.id,
    tower: fac?.tower ?? null,
    asdex: fac?.asdex ?? null,
    twrmap: fac?.twrmap ?? null,
    updated: input.updated ?? '',
    init: {
      jet: input.airport?.jetInitialAltitude || DEFAULT_INITIAL_ALTITUDE,
      prop: input.airport?.propInitialAltitude || DEFAULT_INITIAL_ALTITUDE,
      pattern: input.airport?.patternAltitude || 0,
    },
    stars: input.facilityIndex !== null ? starsForAirport(input.facilityIndex, input.id) : null,
    fleet: compactFleet(input.airport),
    map: input.map,
    scen: input.scen,
  }
}
