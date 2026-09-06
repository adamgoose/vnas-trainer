/**
 * Ground scope: the taxiway graph, gates and aircraft on a Foldkit Canvas. The
 * static layers (pavement graph, gates) are memoised per Graph value because the
 * Canvas repaints the whole shape list on every render.
 */
import { Canvas } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'

import type { Aircraft, AircraftState } from '../domain/aircraft'
import type { LonLat } from '../domain/catalog'
import type { Graph } from '../domain/graph'

export const SCOPE_WIDTH = 1280
export const SCOPE_HEIGHT = 800

export type Viewport = Readonly<{ scale: number; x0: number; y0: number; ftLon: number; ftLat: number }>

export const viewportFor = (graph: Graph): Viewport => {
  const { bounds, projection } = graph
  const worldW = Math.max(1, (bounds.lon1 - bounds.lon0) * projection.ftLon)
  const worldH = Math.max(1, (bounds.lat1 - bounds.lat0) * projection.ftLat)
  const scale = Math.min(SCOPE_WIDTH / worldW, SCOPE_HEIGHT / worldH) * 0.95
  return {
    scale,
    x0: (SCOPE_WIDTH - worldW * scale) / 2,
    y0: (SCOPE_HEIGHT - worldH * scale) / 2,
    ftLon: projection.ftLon,
    ftLat: projection.ftLat,
  }
}

export const project = (graph: Graph, vp: Viewport, c: LonLat): Canvas.Point => ({
  x: vp.x0 + (c[0] - graph.bounds.lon0) * vp.ftLon * vp.scale,
  y: vp.y0 + (graph.bounds.lat1 - c[1]) * vp.ftLat * vp.scale,
})

const staticLayers = new WeakMap<Graph, ReadonlyArray<Canvas.Shape>>()

const buildStaticLayers = (graph: Graph): ReadonlyArray<Canvas.Shape> => {
  const vp = viewportFor(graph)
  const taxi: Array<Canvas.PathInstruction> = []
  const runway: Array<Canvas.PathInstruction> = []
  graph.adjacency.forEach((edges, a) => {
    for (const e of edges) {
      if (e.to < a) {
        continue
      }
      const p = project(graph, vp, graph.nodes[a]!)
      const q = project(graph, vp, graph.nodes[e.to]!)
      const target = graph.runwayNames.includes(e.name) ? runway : taxi
      target.push(Canvas.MoveTo({ x: p.x, y: p.y }), Canvas.LineTo({ x: q.x, y: q.y }))
    }
  })
  const gates = Object.values(graph.parking).map((g) => {
    const p = project(graph, vp, g.c)
    return Canvas.Circle({ x: p.x, y: p.y, radius: 1.5, fill: '#55646c' })
  })
  return [
    Canvas.Rect({ x: 0, y: 0, width: SCOPE_WIDTH, height: SCOPE_HEIGHT, fill: '#0b0e10' }),
    Canvas.Path({ instructions: runway, stroke: '#333d44', lineWidth: 6, lineCap: 'Butt' }),
    Canvas.Path({ instructions: taxi, stroke: '#3c4950', lineWidth: 1.5, lineCap: 'Round' }),
    ...gates,
  ]
}

const staticLayersFor = (graph: Graph): ReadonlyArray<Canvas.Shape> => {
  const cached = staticLayers.get(graph)
  if (cached !== undefined) {
    return cached
  }
  const built = buildStaticLayers(graph)
  staticLayers.set(graph, built)
  return built
}

const STATE_COLOUR: Readonly<Record<AircraftState, string>> = {
  PARKED: '#8496a0',
  PUSH: '#e0a63a',
  PUSHED: '#e0a63a',
  TAXI: '#e0a63a',
  SHORT: '#e0574f',
  HOLD: '#d6e0e5',
  LUAW: '#29b6d8',
  TKOF: '#29b6d8',
  FINAL: '#9b8ce8',
  ROLLOUT: '#9b8ce8',
  AIRB: '#5cbf7a',
}

const aircraftShapes = (
  graph: Graph,
  vp: Viewport,
  aircraft: Aircraft,
  isSelected: boolean,
): ReadonlyArray<Canvas.Shape> => {
  if (aircraft.delay > 0) {
    return []
  }
  const p = project(graph, vp, aircraft.position)
  const r = (aircraft.heading * Math.PI) / 180
  const colour = STATE_COLOUR[aircraft.state]
  return [
    ...(isSelected ? [Canvas.Circle({ x: p.x, y: p.y, radius: 8, stroke: '#ffffff', lineWidth: 1 })] : []),
    Canvas.Path({
      instructions: [
        Canvas.MoveTo({ x: p.x, y: p.y }),
        Canvas.LineTo({ x: p.x + Math.sin(r) * 10, y: p.y - Math.cos(r) * 10 }),
      ],
      stroke: colour,
      lineWidth: 1.5,
    }),
    Canvas.Circle({ x: p.x, y: p.y, radius: 3.5, fill: colour }),
    Canvas.Text({
      x: p.x + 6,
      y: p.y - 6,
      content: aircraft.callsign,
      font: '11px "IBM Plex Mono", Menlo, monospace',
      fill: aircraft.state === 'PARKED' ? '#8496a0' : '#d6e0e5',
      align: 'Left',
      baseline: 'Bottom',
    }),
  ]
}

export const groundScope = <Message>(
  config: Readonly<{
    graph: Graph
    aircraft: ReadonlyArray<Aircraft>
    selected: string | null
    devicePixelRatio: number
    onPointerDown: (point: Canvas.Point) => Message
  }>,
  h: HtmlBuilder<Message>,
): Html => {
  const { graph, aircraft, selected, devicePixelRatio, onPointerDown } = config
  const vp = viewportFor(graph)
  const shapes: ReadonlyArray<Canvas.Shape> = [
    Canvas.Group({
      scale: { x: devicePixelRatio, y: devicePixelRatio },
      shapes: [
        ...staticLayersFor(graph),
        ...aircraft.flatMap((a) => aircraftShapes(graph, vp, a, a.callsign === selected)),
      ],
    }),
  ]
  return Canvas.view(
    {
      width: Math.round(SCOPE_WIDTH * devicePixelRatio),
      height: Math.round(SCOPE_HEIGHT * devicePixelRatio),
      shapes,
      className: 'scope',
      onPointerDown,
    },
    h,
  )
}
