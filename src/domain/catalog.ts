/**
 * Schemas for the baked catalog (docs/REWRITE.md section 6). The builder validates
 * against these when writing catalog/ and the app decodes with them when loading.
 */
import { Schema } from 'effect'

export const LonLat = Schema.Tuple([Schema.Number, Schema.Number])
export type LonLat = typeof LonLat.Type

/** [lon, lat, heading] */
export const ParkingSpot = Schema.Tuple([Schema.Number, Schema.Number, Schema.Number])
export type ParkingSpot = typeof ParkingSpot.Type

export const Taxiway = Schema.Struct({ n: Schema.String, c: Schema.Array(LonLat) })
export type Taxiway = typeof Taxiway.Type

export const Runway = Schema.Struct({
  n: Schema.String,
  c: Schema.Array(LonLat),
  thr: Schema.NullOr(Schema.String),
  to: Schema.NullOr(Schema.String),
})
export type Runway = typeof Runway.Type

export const AirportMap = Schema.Struct({
  taxi: Schema.Array(Taxiway),
  rwy: Schema.Array(Runway),
  park: Schema.Record(Schema.String, ParkingSpot),
  spot: Schema.Record(Schema.String, ParkingSpot),
})
export type AirportMap = typeof AirportMap.Type

export const FleetEntry = Schema.Struct({
  a: Schema.String,
  w: Schema.Number,
  t: Schema.Array(Schema.String),
})
export type FleetEntry = typeof FleetEntry.Type

export const StarsVideoMap = Schema.Struct({
  id: Schema.String,
  sid: Schema.Number,
  sn: Schema.String,
  n: Schema.String,
  b: Schema.String,
  av: Schema.Boolean,
  tdm: Schema.Boolean,
})
export type StarsVideoMap = typeof StarsVideoMap.Type

export const FacilityPosition = Schema.Struct({
  cs: Schema.String,
  name: Schema.String,
  radio: Schema.String,
  freq: Schema.String,
})
export type FacilityPosition = typeof FacilityPosition.Type

export const Stars = Schema.Struct({
  host: Schema.String,
  hostName: Schema.String,
  tcp: Schema.NullOr(Schema.String),
  center: LonLat,
  range: Schema.Number,
  maps: Schema.Array(StarsVideoMap),
  def: Schema.Array(Schema.String),
  /** The builder omits the key when the airport has no tower position. */
  twr: Schema.optionalKey(Schema.NullOr(FacilityPosition)),
  dep: Schema.NullOr(FacilityPosition),
  /** approach and centre positions (Phase 8); older catalog files omit them */
  app: Schema.optionalKey(Schema.NullOr(FacilityPosition)),
  ctr: Schema.optionalKey(Schema.NullOr(FacilityPosition)),
})
export type Stars = typeof Stars.Type

/** A SID or STAR from NavData: transitions are the branches, common the shared part. */
export const Procedure = Schema.Struct({
  id: Schema.String,
  transitions: Schema.Array(Schema.Array(Schema.String)),
  common: Schema.Array(Schema.String),
})
export type Procedure = typeof Procedure.Type

/** The fixes and procedures around an airport, keyed by name (procedures without the revision digit). */
export const AirportNav = Schema.Struct({
  fixes: Schema.Record(Schema.String, LonLat),
  stars: Schema.Record(Schema.String, Procedure),
  sids: Schema.Record(Schema.String, Procedure),
})
export type AirportNav = typeof AirportNav.Type

export const InitialAltitudes = Schema.Struct({
  jet: Schema.Number,
  prop: Schema.Number,
  pattern: Schema.Number,
})
export type InitialAltitudes = typeof InitialAltitudes.Type

/** Parking, on the Runway, on Final, Airborne */
export const SpawnKind = Schema.Literals(['P', 'R', 'F', 'A'])
export type SpawnKind = typeof SpawnKind.Type

export const ScenarioAircraft = Schema.Struct({
  cs: Schema.String,
  ty: Schema.String,
  k: SpawnKind,
  /** gate, runway, or the fix an airborne start was given as */
  at: Schema.String,
  /** airborne starts: position, altitude (ft), speed (kt), heading, raw navigation path */
  pos: Schema.optionalKey(LonLat),
  fa: Schema.optionalKey(Schema.Number),
  ias: Schema.optionalKey(Schema.Number),
  hdg: Schema.optionalKey(Schema.Number),
  nav: Schema.optionalKey(Schema.String),
  d: Schema.Number,
  dep: Schema.NullOr(Schema.String),
  dst: Schema.NullOr(Schema.String),
  r: Schema.String,
  tyf: Schema.optionalKey(Schema.String),
  rte: Schema.optionalKey(Schema.String),
  alt: Schema.optionalKey(Schema.Number),
  spd: Schema.optionalKey(Schema.Number),
  rmk: Schema.optionalKey(Schema.String),
  sid: Schema.optionalKey(Schema.String),
  star: Schema.optionalKey(Schema.String),
  app: Schema.optionalKey(Schema.String),
  q: Schema.optionalKey(Schema.Number),
  nm: Schema.optionalKey(Schema.Number),
})
export type ScenarioAircraft = typeof ScenarioAircraft.Type

export const Scenario = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  stu: Schema.NullOr(Schema.String),
  n: Schema.Number,
  air: Schema.Number,
  gen: Schema.Array(Schema.String),
  ac: Schema.Array(ScenarioAircraft),
})
export type Scenario = typeof Scenario.Type

export const AirportFile = Schema.Struct({
  id: Schema.String,
  artcc: Schema.String,
  name: Schema.String,
  tower: Schema.NullOr(LonLat),
  asdex: Schema.NullOr(Schema.String),
  twrmap: Schema.NullOr(Schema.String),
  updated: Schema.String,
  init: InitialAltitudes,
  stars: Schema.NullOr(Stars),
  fleet: Schema.Array(FleetEntry),
  map: AirportMap,
  scen: Schema.Array(Scenario),
  /** Phase 8; a catalog built before it has no nav block or field elevation */
  nav: Schema.optionalKey(AirportNav),
  /** field elevation, feet (from NavData) */
  elev: Schema.optionalKey(Schema.Number),
})
export type AirportFile = typeof AirportFile.Type

export const CatalogAirportSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  n: Schema.Number,
  asdex: Schema.Boolean,
  gates: Schema.Number,
  taxi: Schema.Number,
  stars: Schema.Boolean,
})
export type CatalogAirportSummary = typeof CatalogAirportSummary.Type

export const CatalogIndex = Schema.Struct({
  built: Schema.String,
  artccs: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      airports: Schema.Array(CatalogAirportSummary),
    }),
  ),
})
export type CatalogIndex = typeof CatalogIndex.Type

export const decodeAirportFile = Schema.decodeUnknownSync(AirportFile)
export const decodeCatalogIndex = Schema.decodeUnknownSync(CatalogIndex)
