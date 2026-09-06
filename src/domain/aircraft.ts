/**
 * The simulated aircraft: one record covers the ground roll, the flight model and
 * the radar picture, so a departure is the same value from the gate to the handoff.
 */
import { Schema } from 'effect'

import { LonLat } from './catalog'

export const AircraftState = Schema.Literals([
  'PARKED', 'PUSH', 'PUSHED', 'TAXI', 'SHORT', 'HOLD', 'LUAW', 'TKOF', 'FINAL', 'ROLLOUT', 'AIRB',
])
export type AircraftState = typeof AircraftState.Type

export const Transponder = Schema.Literals(['N', 'S', 'I'])
export type Transponder = typeof Transponder.Type

export const RadarReturn = Schema.Struct({
  position: LonLat,
  altitude: Schema.Number,
  speed: Schema.Number,
  history: Schema.Array(LonLat),
})
export type RadarReturn = typeof RadarReturn.Type

export const FlightPlan = Schema.Struct({
  rules: Schema.String,
  fullType: Schema.NullOr(Schema.String),
  route: Schema.NullOr(Schema.String),
  cruiseAltitude: Schema.NullOr(Schema.Number),
  cruiseSpeed: Schema.NullOr(Schema.Number),
  remarks: Schema.NullOr(Schema.String),
  sid: Schema.NullOr(Schema.String),
  star: Schema.NullOr(Schema.String),
  approach: Schema.NullOr(Schema.String),
})
export type FlightPlan = typeof FlightPlan.Type

export const Aircraft = Schema.Struct({
  callsign: Schema.String,
  type: Schema.String,
  state: AircraftState,
  position: LonLat,
  heading: Schema.Number,
  /** knots */
  speed: Schema.Number,
  /** node path; leg i runs from path[i] (or origin on leg 0) to path[i+1] */
  path: Schema.NullOr(Schema.Array(Schema.Number)),
  leg: Schema.Number,
  frac: Schema.Number,
  /** where leg 0 starts when the aircraft is not on a node (a gate, a final) */
  origin: Schema.NullOr(LonLat),
  /** leg index to stop at (a runway not yet cleared, or a HS point) */
  holdLeg: Schema.NullOr(Schema.Number),
  /** runways this taxi clearance may enter */
  cleared: Schema.Array(Schema.String),
  blockedBy: Schema.NullOr(Schema.String),
  /** sim time until which conflicts are ignored (BREAK) */
  breakUntil: Schema.Number,
  giveWayTo: Schema.NullOr(Schema.String),
  /** seconds until the aircraft comes on frequency */
  delay: Schema.Number,
  gate: Schema.NullOr(Schema.String),
  runway: Schema.NullOr(Schema.String),
  destinationGate: Schema.NullOr(Schema.String),
  lineUpAfterTaxi: Schema.Boolean,
  departure: Schema.NullOr(Schema.String),
  destination: Schema.NullOr(Schema.String),
  squawk: Schema.String,
  transponder: Transponder,
  identUntil: Schema.Number,
  history: Schema.Array(LonLat),
  altitude: Schema.Number,
  targetAltitude: Schema.Number,
  targetHeading: Schema.Number,
  targetSpeed: Schema.Number,
  verticalSpeed: Schema.Number,
  turn: Schema.NullOr(Schema.Literals(['L', 'R'])),
  tracked: Schema.Boolean,
  handoff: Schema.Boolean,
  handoffAt: Schema.Number,
  clearedToLand: Schema.Boolean,
  landed: Schema.Boolean,
  goingAround: Schema.Boolean,
  airborneAt: Schema.NullOr(Schema.Number),
  radar: Schema.NullOr(RadarReturn),
  flightPlan: FlightPlan,
})
export type Aircraft = typeof Aircraft.Type

export const emptyFlightPlan: FlightPlan = {
  rules: 'I',
  fullType: null,
  route: null,
  cruiseAltitude: null,
  cruiseSpeed: null,
  remarks: null,
  sid: null,
  star: null,
  approach: null,
}

export const makeAircraft = (fields: Partial<Aircraft> & Pick<Aircraft, 'callsign' | 'type'>): Aircraft => ({
  state: 'PARKED',
  position: [0, 0],
  heading: 0,
  speed: 0,
  path: null,
  leg: 0,
  frac: 0,
  origin: null,
  holdLeg: null,
  cleared: [],
  blockedBy: null,
  breakUntil: -1,
  giveWayTo: null,
  delay: 0,
  gate: null,
  runway: null,
  destinationGate: null,
  lineUpAfterTaxi: false,
  departure: null,
  destination: null,
  squawk: '1200',
  transponder: 'S',
  identUntil: -1,
  history: [],
  altitude: 0,
  targetAltitude: 0,
  targetHeading: 0,
  targetSpeed: 0,
  verticalSpeed: 0,
  turn: null,
  tracked: false,
  handoff: false,
  handoffAt: 0,
  clearedToLand: false,
  landed: false,
  goingAround: false,
  airborneAt: null,
  radar: null,
  flightPlan: emptyFlightPlan,
  ...fields,
})

// PERFORMANCE

const PROP_TYPES =
  /^(C1\d\d|C2\d\d|C3\d\d|C4\d\d|P\d{2}|PA\d\d|BE\d\d|B190|SW[234]|AT[47]\d|DH8|SF34|E120|C208|PC12|TBM|SR2\d|DA4\d|DA62|M20|AC\d|J328|D328|AN\d|L410|C441|MU2|PAY\d|P180)/

export const isProp = (type: string): boolean => PROP_TYPES.test(type)

export type Performance = Readonly<{
  prop: boolean
  /** rotation speed, knots */
  vr: number
  /** takeoff roll acceleration, knots per second */
  accel: number
  climbSpeed: number
  /** feet per minute */
  verticalSpeed: number
  initialAltitude: number
}>

export const performance = (type: string, init: Readonly<{ jet: number; prop: number }>): Performance => {
  const prop = isProp(type)
  return {
    prop,
    vr: prop ? 65 : 135,
    accel: prop ? 4 : 6,
    climbSpeed: prop ? 140 : 250,
    verticalSpeed: prop ? 1000 : 2500,
    initialAltitude: (prop ? init.prop : init.jet) || 5000,
  }
}

/** Where the aircraft is visible to radar. */
export const isRadarVisible = (a: Aircraft): boolean =>
  a.delay <= 0 && (a.state === 'AIRB' || a.state === 'FINAL' || a.state === 'ROLLOUT' || (a.state === 'TKOF' && a.speed > 40))
