/**
 * Ground scope viewport maths (pure): world feet from the graph bounds, the fit,
 * zoom about a point, pan, and hit testing. Shared by update (interaction) and the
 * scope view (drawing).
 */
import type { LonLat } from '../domain/catalog'
import type { Graph } from '../domain/graph'
import type { ScopeView } from '../app/model'

export const FIT_PADDING = 0.04
export const MIN_VIEW_FRACTION = 0.03
/** zoomed right out, the longer side of the field takes this fraction of the matching side of the view */
export const MAX_VIEW_FRACTION = 3
export const WHEEL_IN = 0.885
export const WHEEL_OUT = 1.13
export const BUTTON_IN = 0.7
export const BUTTON_OUT = 1.42
export const HIT_FRACTION = 0.035

export type WorldPoint = Readonly<{ x: number; y: number }>

export const worldSize = (graph: Graph): Readonly<{ w: number; h: number }> => ({
  w: Math.max(1, (graph.bounds.lon1 - graph.bounds.lon0) * graph.projection.ftLon),
  h: Math.max(1, (graph.bounds.lat1 - graph.bounds.lat0) * graph.projection.ftLat),
})

/** Feet east and south of the graph's top-left corner. */
export const toWorld = (graph: Graph, c: LonLat): WorldPoint => ({
  x: (c[0] - graph.bounds.lon0) * graph.projection.ftLon,
  y: (graph.bounds.lat1 - c[1]) * graph.projection.ftLat,
})

export const toCanvas = (view: ScopeView, p: WorldPoint): WorldPoint => ({
  x: (p.x - view.originX) * view.scale,
  y: (p.y - view.originY) * view.scale,
})

export const canvasToWorld = (view: ScopeView, x: number, y: number): WorldPoint => ({
  x: view.originX + x / view.scale,
  y: view.originY + y / view.scale,
})

/** Width of the view in feet; the legacy `view.w`. */
export const viewWidthFt = (view: ScopeView): number => view.width / view.scale

export const fit = (graph: Graph, view: ScopeView): ScopeView => {
  const { w, h } = worldSize(graph)
  const pad = w * FIT_PADDING
  const scale = Math.min(view.width / (w + 2 * pad), view.height / (h + 2 * pad))
  return {
    ...view,
    scale,
    originX: w / 2 - view.width / (2 * scale),
    originY: h / 2 - view.height / (2 * scale),
    fitted: true,
  }
}

/**
 * The widest view allowed, in feet: the field's width or, in a view taller than
 * the field is wide, its height scaled by the view's aspect, times the maximum
 * fraction, so a tall narrow pane can still zoom out to see the whole field.
 */
export const maxViewWidthFt = (graph: Graph, view: ScopeView): number => {
  const { w, h } = worldSize(graph)
  const aspect = view.height > 0 ? view.width / view.height : 1
  return MAX_VIEW_FRACTION * Math.max(w, h * aspect)
}

/** Multiply the visible width by `k` keeping the world point under (x, y) fixed. */
export const zoomAt = (graph: Graph, view: ScopeView, x: number, y: number, k: number): ScopeView => {
  const { w } = worldSize(graph)
  const wanted = viewWidthFt(view) * k
  const clamped = Math.max(w * MIN_VIEW_FRACTION, Math.min(maxViewWidthFt(graph, view), wanted))
  const scale = view.width / clamped
  const under = canvasToWorld(view, x, y)
  return { ...view, scale, originX: under.x - x / scale, originY: under.y - y / scale }
}

/** New canvas size keeping the world centre and the visible width in feet (the legacy viewBox behaviour). */
export const resize = (view: ScopeView, width: number, height: number): ScopeView => {
  if (view.width <= 0 || view.scale <= 0) {
    return { ...view, width, height }
  }
  const centre = canvasToWorld(view, view.width / 2, view.height / 2)
  const scale = width / viewWidthFt(view)
  return { ...view, width, height, scale, originX: centre.x - width / (2 * scale), originY: centre.y - height / (2 * scale) }
}

export const zoomCentre = (graph: Graph, view: ScopeView, k: number): ScopeView =>
  zoomAt(graph, view, view.width / 2, view.height / 2, k)

export const pan = (view: ScopeView, originX: number, originY: number, dx: number, dy: number): ScopeView => ({
  ...view,
  originX: originX - dx / view.scale,
  originY: originY - dy / view.scale,
})

/** The nearest candidate within 3.5 % of the view width, or null. */
export const hitTest = <A>(
  graph: Graph,
  view: ScopeView,
  x: number,
  y: number,
  candidates: ReadonlyArray<A>,
  positionOf: (a: A) => LonLat,
): A | null => {
  const target = canvasToWorld(view, x, y)
  const limit = viewWidthFt(view) * HIT_FRACTION
  let best: A | null = null
  let bestDistance = Infinity
  for (const a of candidates) {
    const p = toWorld(graph, positionOf(a))
    const d = Math.hypot(p.x - target.x, p.y - target.y)
    if (d < bestDistance) {
      bestDistance = d
      best = a
    }
  }
  return best !== null && bestDistance < limit ? best : null
}
