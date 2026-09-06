/**
 * The simulation state and the events it emits. A World is plain data inside the
 * Model; every change to it is a pure function in physics.ts, scenario.ts or
 * commands.ts, which return the next World plus SimEvents for the app to log,
 * speak or apply to its own state.
 */
import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { Aircraft } from './aircraft'
import { type AirportFile, FleetEntry, InitialAltitudes, LonLat } from './catalog'
import { Graph, buildGraph } from './graph'
import { Phrase } from './phrase'
import { Prng, seedPrng } from './prng'
import { PositionRules } from './rules'

export const RadioPosition = Schema.Struct({ radio: Schema.String, freq: Schema.NullOr(Schema.String) })
export type RadioPosition = typeof RadioPosition.Type

/** The parts of an airport file the simulation reads. */
export const WorldAirport = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  init: InitialAltitudes,
  radarCenter: Schema.NullOr(LonLat),
  towerRadio: Schema.NullOr(Schema.String),
  departure: Schema.NullOr(RadioPosition),
  fleet: Schema.Array(FleetEntry),
})
export type WorldAirport = typeof WorldAirport.Type

export const ScenarioInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** arrival generator runways */
  gen: Schema.Array(Schema.String),
})
export type ScenarioInfo = typeof ScenarioInfo.Type

export const World = Schema.Struct({
  airport: WorldAirport,
  graph: Graph,
  rules: PositionRules,
  aircraft: Schema.Array(Aircraft),
  prng: Prng,
  /** sim seconds */
  simTime: Schema.Number,
  /** physics steps taken */
  tick: Schema.Number,
  arrivalsEnabled: Schema.Boolean,
  nextArrivalAt: Schema.Number,
  scenario: Schema.NullOr(ScenarioInfo),
})
export type World = typeof World.Type

export const SimEvent = defineTaggedUnion({
  PilotSaid: { callsign: Schema.String, phrase: Phrase },
  SystemNote: { text: Schema.String },
  Removed: { callsign: Schema.String, text: Schema.String },
  SetRunning: { running: Schema.Boolean },
  SetRate: { rate: Schema.Number },
})
export type SimEvent = typeof SimEvent.Type

export type WorldResult = Readonly<{ world: World; events: ReadonlyArray<SimEvent> }>

export const radarCenterOf = (airport: AirportFile): LonLat | null => {
  if (airport.stars !== null) {
    return airport.stars.center
  }
  if (airport.tower !== null) {
    return airport.tower
  }
  return null
}

export const makeWorld = (airport: AirportFile, rules: PositionRules, seed: number): World => {
  const graph = buildGraph(airport.map)
  const center = radarCenterOf(airport) ?? [
    (graph.bounds.lon0 + graph.bounds.lon1) / 2,
    (graph.bounds.lat0 + graph.bounds.lat1) / 2,
  ]
  const dep = airport.stars?.dep ?? null
  return {
    airport: {
      id: airport.id,
      name: airport.name,
      init: airport.init,
      radarCenter: center,
      towerRadio: airport.stars?.twr?.radio ?? null,
      departure: dep === null ? null : { radio: dep.radio, freq: dep.freq },
      fleet: airport.fleet,
    },
    graph,
    rules,
    aircraft: [],
    prng: seedPrng(seed),
    simTime: 0,
    tick: 0,
    arrivalsEnabled: false,
    nextArrivalAt: 0,
    scenario: null,
  }
}

export const findAircraft = (world: World, callsign: string): Aircraft | undefined =>
  world.aircraft.find((a) => a.callsign === callsign)

/** Exact match, else a unique prefix or suffix match; case-insensitive. */
export const matchCallsign = (world: World, query: string): Aircraft | null => {
  const q = query.toUpperCase()
  const exact = world.aircraft.filter((a) => a.callsign === q)
  if (exact.length === 1) {
    return exact[0]!
  }
  const partial = world.aircraft.filter((a) => a.callsign.endsWith(q) || a.callsign.startsWith(q))
  return partial.length === 1 ? partial[0]! : null
}

export const replaceAircraft = (world: World, next: Aircraft): World => ({
  ...world,
  aircraft: world.aircraft.map((a) => (a.callsign === next.callsign ? next : a)),
})

export const removeAircraft = (world: World, callsign: string): World => ({
  ...world,
  aircraft: world.aircraft.filter((a) => a.callsign !== callsign),
})

export const towerRadioName = (world: World): string =>
  world.airport.towerRadio ?? `${world.airport.name.replace(/\s+(ATCT|Tower).*$/i, '')} Tower`
