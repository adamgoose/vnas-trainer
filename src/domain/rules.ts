/**
 * What a control position changes about the simulation. Ground, Local and
 * Approach supply one of these; the domain never asks which position is active.
 */
import { Schema } from 'effect'

export const PositionRules = Schema.Struct({
  /** arrivals appear this far out on final */
  arrivalFinalNm: Schema.Number,
  /** without CTL an arrival goes around at 1 nm */
  requireLandingClearance: Schema.Boolean,
  /** arrivals call the tower when they appear */
  checkInOnFinal: Schema.Boolean,
  /** aircraft further than this from the radar centre leave the simulation */
  radarRangeNm: Schema.Number,
  /** generated arrivals start on final, or at a STAR entry */
  arrivalsFrom: Schema.Literals(['final', 'star']),
  /** airborne aircraft call the approach when they come on frequency */
  checkInAirborne: Schema.Boolean,
  /** where CD sends a departure */
  handoffTo: Schema.Literals(['departure', 'center']),
  /** arrivals leave the simulation when they have landed (the tower automation has them) */
  landingRemoves: Schema.Boolean,
  /** scenario aircraft that start airborne (or on the field ready to depart) are loaded */
  loadsAirborne: Schema.Boolean,
})
export type PositionRules = typeof PositionRules.Type

export const GROUND_RULES: PositionRules = {
  arrivalFinalNm: 3,
  requireLandingClearance: false,
  checkInOnFinal: false,
  radarRangeNm: 16,
  arrivalsFrom: 'final',
  checkInAirborne: false,
  handoffTo: 'departure',
  landingRemoves: false,
  loadsAirborne: false,
}

export const LOCAL_RULES: PositionRules = {
  arrivalFinalNm: 6,
  requireLandingClearance: true,
  checkInOnFinal: true,
  radarRangeNm: 16,
  arrivalsFrom: 'final',
  checkInAirborne: false,
  handoffTo: 'departure',
  landingRemoves: false,
  loadsAirborne: false,
}

export const TRACON_RULES: PositionRules = {
  arrivalFinalNm: 10,
  requireLandingClearance: false,
  checkInOnFinal: false,
  /** scenario aircraft start up to 150 nm out and fly in; the STARS area itself is 40 to 60 nm */
  radarRangeNm: 150,
  arrivalsFrom: 'star',
  checkInAirborne: true,
  handoffTo: 'center',
  landingRemoves: true,
  loadsAirborne: true,
}
