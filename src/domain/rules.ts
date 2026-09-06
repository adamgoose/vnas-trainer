/**
 * What a control position changes about the simulation. Ground and Local supply
 * one of these; the domain never asks which position is active.
 */
import { Schema } from 'effect'

export const PositionRules = Schema.Struct({
  /** arrivals appear this far out on final */
  arrivalFinalNm: Schema.Number,
  /** without CTL an arrival goes around at 1 nm */
  requireLandingClearance: Schema.Boolean,
  /** arrivals call the tower when they appear */
  checkInOnFinal: Schema.Boolean,
})
export type PositionRules = typeof PositionRules.Type

export const GROUND_RULES: PositionRules = {
  arrivalFinalNm: 3,
  requireLandingClearance: false,
  checkInOnFinal: false,
}

export const LOCAL_RULES: PositionRules = {
  arrivalFinalNm: 6,
  requireLandingClearance: true,
  checkInOnFinal: true,
}
