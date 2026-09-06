/**
 * vNAS video maps (`/Files/VideoMaps/{ARTCC}/{id}.geojson`) reduced to what the
 * scopes draw: polygons (ASDE-X pavement by category) and lines (STARS maps,
 * tower-cab maps). Malformed features are dropped rather than failing the map.
 */
import { Schema } from 'effect'

import { LonLat } from './catalog'
import type { GeoJson } from './vnas'

export const Ring = Schema.Array(LonLat)
export type Ring = typeof Ring.Type

export const VideoMapFeature = Schema.Struct({
  /** ASDE-X category: apron | structure | taxiway | runway | hold | other */
  asdex: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  thickness: Schema.NullOr(Schema.Number),
  /** each polygon is its rings, outer first */
  polygons: Schema.Array(Schema.Array(Ring)),
  lines: Schema.Array(Ring),
})
export type VideoMapFeature = typeof VideoMapFeature.Type

export const VideoMap = Schema.Struct({
  id: Schema.String,
  features: Schema.Array(VideoMapFeature),
})
export type VideoMap = typeof VideoMap.Type

const isLonLat = (c: unknown): c is LonLat =>
  Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number'
const toRing = (v: unknown): Ring | null =>
  Array.isArray(v) && v.every(isLonLat) ? v.map((c): LonLat => [c[0], c[1]]) : null
const toRings = (v: unknown): Array<Ring> | null => {
  if (!Array.isArray(v)) {
    return null
  }
  const rings = v.map(toRing)
  return rings.every((r): r is Ring => r !== null) ? rings : null
}

export const parseVideoMap = (id: string, json: GeoJson): VideoMap => {
  const features: Array<VideoMapFeature> = []
  for (const f of json.features ?? []) {
    const g = f.geometry
    const p = f.properties ?? {}
    if (!g) {
      continue
    }
    const polygons: Array<Array<Ring>> = []
    const lines: Array<Ring> = []
    if (g.type === 'Polygon') {
      const rings = toRings(g.coordinates)
      if (rings !== null) {
        polygons.push(rings)
      }
    } else if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
      for (const poly of g.coordinates) {
        const rings = toRings(poly)
        if (rings !== null) {
          polygons.push(rings)
        }
      }
    } else if (g.type === 'LineString') {
      const line = toRing(g.coordinates)
      if (line !== null) {
        lines.push(line)
      }
    } else if (g.type === 'MultiLineString') {
      const many = toRings(g.coordinates)
      if (many !== null) {
        lines.push(...many)
      }
    }
    if (polygons.length === 0 && lines.length === 0) {
      continue
    }
    const thickness = typeof p['thickness'] === 'number' ? p['thickness'] : null
    features.push({
      asdex: typeof p['asdex'] === 'string' ? p['asdex'] : null,
      color: typeof p['color'] === 'string' ? p['color'] : null,
      thickness,
      polygons,
      lines,
    })
  }
  return { id, features }
}

/** Every line to stroke on a radar scope: lines plus polygon rings. */
export const strokeRings = (map: VideoMap): ReadonlyArray<Ring> =>
  map.features.flatMap((f) => [...f.lines, ...f.polygons.flat()])
