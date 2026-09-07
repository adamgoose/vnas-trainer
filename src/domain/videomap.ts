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
  /** ASDE-X category, lower-cased: apron | structure | taxiway | runway | hold | other */
  asdex: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  thickness: Schema.NullOr(Schema.Number),
  /** tower-cab maps: draw order, low first */
  zIndex: Schema.NullOr(Schema.Number),
  /** each polygon is its rings, outer first */
  polygons: Schema.Array(Schema.Array(Ring)),
  lines: Schema.Array(Ring),
  /** ERAM GeoMaps (Phase 9): symbol and text features are points; text lines; per-feature filter, BCG and style overrides */
  points: Schema.Array(LonLat),
  text: Schema.NullOr(Schema.Array(Schema.String)),
  filters: Schema.NullOr(Schema.Array(Schema.Number)),
  bcg: Schema.NullOr(Schema.Number),
  style: Schema.NullOr(Schema.String),
})
export type VideoMapFeature = typeof VideoMapFeature.Type

/**
 * An ERAM map's defaults, from the leading `is*Defaults` feature vNAS writes:
 * what kind of elements the file holds, the filter buttons it belongs to (0 is
 * "always"), its brightness control group, style and size.
 */
export const EramDefaults = Schema.Struct({
  kind: Schema.Literals(['line', 'symbol', 'text']),
  filters: Schema.Array(Schema.Number),
  bcg: Schema.Number,
  style: Schema.NullOr(Schema.String),
  /** line thickness or symbol/text size */
  size: Schema.Number,
  xOffset: Schema.Number,
  yOffset: Schema.Number,
})
export type EramDefaults = typeof EramDefaults.Type

export const VideoMap = Schema.Struct({
  id: Schema.String,
  features: Schema.Array(VideoMapFeature),
  eram: Schema.NullOr(EramDefaults),
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

const numbers = (v: unknown): Array<number> | null => (Array.isArray(v) && v.every((x) => typeof x === 'number') ? (v as Array<number>) : null)
const stringsOf = (v: unknown): Array<string> | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as Array<string>) : null)

/** The `is*Defaults` feature of an ERAM map, or null for STARS, ASDE-X and tower-cab maps. */
const eramDefaults = (p: Readonly<Record<string, unknown>>): EramDefaults | null => {
  const kind = p['isLineDefaults'] === true ? 'line' : p['isSymbolDefaults'] === true ? 'symbol' : p['isTextDefaults'] === true ? 'text' : null
  if (kind === null) {
    return null
  }
  const size = typeof p['thickness'] === 'number' ? p['thickness'] : typeof p['size'] === 'number' ? p['size'] : 1
  return {
    kind,
    filters: numbers(p['filters']) ?? [0],
    bcg: typeof p['bcg'] === 'number' ? p['bcg'] : 0,
    style: typeof p['style'] === 'string' ? p['style'] : null,
    size,
    xOffset: typeof p['xOffset'] === 'number' ? p['xOffset'] : 0,
    yOffset: typeof p['yOffset'] === 'number' ? p['yOffset'] : 0,
  }
}

export const parseVideoMap = (id: string, json: GeoJson): VideoMap => {
  const features: Array<VideoMapFeature> = []
  let eram: EramDefaults | null = null
  for (const f of json.features ?? []) {
    const g = f.geometry
    const p = f.properties ?? {}
    if (!g) {
      continue
    }
    const defaults = eramDefaults(p)
    if (defaults !== null) {
      eram ??= defaults
      continue
    }
    const polygons: Array<Array<Ring>> = []
    const lines: Array<Ring> = []
    const points: Array<LonLat> = []
    if (g.type === 'Point' && isLonLat(g.coordinates)) {
      points.push([g.coordinates[0], g.coordinates[1]])
    } else if (g.type === 'Polygon') {
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
    const text = stringsOf(p['text'])
    if (polygons.length === 0 && lines.length === 0 && (points.length === 0 || eram === null)) {
      continue
    }
    const thickness = typeof p['thickness'] === 'number' ? p['thickness'] : null
    features.push({
      asdex: typeof p['asdex'] === 'string' ? p['asdex'].trim().toLowerCase() : null,
      color: typeof p['color'] === 'string' ? p['color'] : null,
      thickness,
      zIndex: typeof p['zIndex'] === 'number' ? p['zIndex'] : null,
      polygons,
      lines,
      points,
      text: text === null || text.length === 0 ? null : text,
      filters: numbers(p['filters']),
      bcg: typeof p['bcg'] === 'number' ? p['bcg'] : null,
      style: typeof p['style'] === 'string' ? p['style'] : null,
    })
  }
  return { id, features, eram }
}

/** Whether an ERAM feature shows under the filters switched on (filter 0 is always on). */
export const eramFeatureVisible = (map: VideoMap, f: VideoMapFeature, on: ReadonlySet<number>): boolean => {
  const filters = f.filters ?? map.eram?.filters ?? [0]
  return filters.some((i) => i === 0 || on.has(i))
}

/**
 * A layer of a tower-cab map: the features that share a colour, a draw order and
 * a kind (filled polygons or stroked lines). Cab maps carry nothing else that
 * would name a layer, so this is what the DISP panel offers to toggle.
 */
export type CabLayer = Readonly<{ key: string; color: string | null; zIndex: number; kind: 'fill' | 'line'; count: number }>

export const cabLayerKey = (f: VideoMapFeature, kind: 'fill' | 'line'): string => `${kind}:${f.color ?? ''}:${f.zIndex ?? 0}`

/** The layers of a map, in draw order: by zIndex, fills before lines, then colour. */
export const cabLayers = (map: VideoMap): ReadonlyArray<CabLayer> => {
  const layers = new Map<string, { layer: CabLayer; count: number }>()
  for (const f of map.features) {
    const kinds: Array<'fill' | 'line'> = [...(f.polygons.length > 0 ? ['fill' as const] : []), ...(f.lines.length > 0 ? ['line' as const] : [])]
    for (const kind of kinds) {
      const key = cabLayerKey(f, kind)
      const entry = layers.get(key) ?? { layer: { key, color: f.color, zIndex: f.zIndex ?? 0, kind, count: 0 }, count: 0 }
      entry.count += 1
      layers.set(key, entry)
    }
  }
  return [...layers.values()]
    .map(({ layer, count }) => ({ ...layer, count }))
    .sort((a, b) => a.zIndex - b.zIndex || (a.kind === b.kind ? 0 : a.kind === 'fill' ? -1 : 1) || (a.color ?? '').localeCompare(b.color ?? ''))
}

/** Every line to stroke on a radar scope: lines plus polygon rings. */
export const strokeRings = (map: VideoMap): ReadonlyArray<Ring> =>
  map.features.flatMap((f) => [...f.lines, ...f.polygons.flat()])
