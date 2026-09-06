/**
 * Geometry in the two units the trainer uses: feet on the ground (local
 * equirectangular scaling fixed at the airport's mid latitude) and nautical miles
 * on the radar. Positions are [lon, lat].
 */
import { Schema } from 'effect'

import type { LonLat } from './catalog'

export const FT_LAT = 364000
export const NM_LAT = 60
export const FT_PER_NM = 6076
export const KT_TO_FT_PER_S = 1.68781

export const Projection = Schema.Struct({ ftLon: Schema.Number, ftLat: Schema.Number })
export type Projection = typeof Projection.Type

export const projectionAt = (latitude: number): Projection => ({
  ftLon: FT_LAT * Math.cos((latitude * Math.PI) / 180),
  ftLat: FT_LAT,
})

export const distanceFt = (p: Projection, a: LonLat, b: LonLat): number =>
  Math.hypot((a[0] - b[0]) * p.ftLon, (a[1] - b[1]) * p.ftLat)

/** True bearing in degrees from a to b, 0 = north, clockwise. */
export const bearingDeg = (p: Projection, a: LonLat, b: LonLat): number =>
  ((Math.atan2((b[0] - a[0]) * p.ftLon, (b[1] - a[1]) * p.ftLat) * 180) / Math.PI + 360) % 360

export const movePoint = (p: Projection, c: LonLat, bearing: number, feet: number): LonLat => {
  const r = (bearing * Math.PI) / 180
  return [c[0] + (Math.sin(r) * feet) / p.ftLon, c[1] + (Math.cos(r) * feet) / p.ftLat]
}

/** Signed difference from `from` to `to`, in (-180, 180]. */
export const turnDelta = (from: number, to: number): number => ((to - from + 540) % 360) - 180

/** Smallest absolute difference between two headings, 0..180. */
export const headingDiff = (a: number, b: number): number => Math.abs(turnDelta(a, b))

export const reciprocal = (bearing: number): number => (bearing + 180) % 360

/** Radar plane: nautical miles east and south of a centre. */
export const RadarProjection = Schema.Struct({ nmLon: Schema.Number, nmLat: Schema.Number })
export type RadarProjection = typeof RadarProjection.Type

export const radarProjectionAt = (latitude: number): RadarProjection => ({
  nmLon: NM_LAT * Math.cos((latitude * Math.PI) / 180),
  nmLat: NM_LAT,
})

export const nmOffset = (rp: RadarProjection, center: LonLat, c: LonLat): readonly [number, number] => [
  (c[0] - center[0]) * rp.nmLon,
  (center[1] - c[1]) * rp.nmLat,
]

export const nmFromCenter = (rp: RadarProjection, center: LonLat, c: LonLat): number =>
  Math.hypot(...nmOffset(rp, center, c))
