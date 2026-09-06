/**
 * The ground scope on a Foldkit Canvas: ASDE-X pavement (or the tower-cab map),
 * the centreline network, runways with designators, gates, and aircraft with
 * trails and labels. Static layers are memoised per viewport because the Canvas
 * repaints the whole shape list on every render.
 */
import { Canvas } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { videoMapById } from '../app/mapCache'
import { type Model, type ScopeView, worldOf } from '../app/model'
import { Message } from '../app/message'
import { ScopeSurface } from '../app/commands'
import type { Aircraft, AircraftState } from '../domain/aircraft'
import type { Graph } from '../domain/graph'
import type { Ring, VideoMap } from '../domain/videomap'
import { toCanvas, toWorld, viewWidthFt, worldSize } from './viewport'

export const COLOURS = {
  bg: '#0b0e10',
  paveRunway: '#333d44',
  paveTaxiway: '#222a2f',
  paveStructure: '#161c20',
  net: '#3c4950',
  ink: '#d6e0e5',
  ink3: '#55646c',
  amber: '#e0a63a',
  cyan: '#29b6d8',
  green: '#5cbf7a',
  red: '#e0574f',
  violet: '#9b8ce8',
}

export const STATE_COLOUR: Readonly<Record<AircraftState, string>> = {
  PARKED: COLOURS.ink3,
  PUSH: COLOURS.violet,
  PUSHED: COLOURS.violet,
  TAXI: COLOURS.green,
  SHORT: COLOURS.amber,
  HOLD: COLOURS.red,
  LUAW: COLOURS.cyan,
  TKOF: COLOURS.cyan,
  FINAL: COLOURS.cyan,
  ROLLOUT: COLOURS.cyan,
  AIRB: COLOURS.cyan,
}

export const STATE_TEXT: Readonly<Record<AircraftState, string>> = {
  PARKED: 'gate', PUSH: 'push', PUSHED: 'ready', TAXI: 'taxi', SHORT: 'short', HOLD: 'hold',
  LUAW: 'luaw', TKOF: 'roll', FINAL: 'final', ROLLOUT: 'rollout', AIRB: 'airborne',
}

const MONO = '"IBM Plex Mono", Menlo, monospace'

type Accent = Readonly<{ accent: string }>

const ringInstructions = (graph: Graph, view: ScopeView, ring: Ring, close: boolean): Array<Canvas.PathInstruction> => {
  const out: Array<Canvas.PathInstruction> = []
  ring.forEach((c, i) => {
    const p = toCanvas(view, toWorld(graph, c))
    out.push(i === 0 ? Canvas.MoveTo({ x: p.x, y: p.y }) : Canvas.LineTo({ x: p.x, y: p.y }))
  })
  if (close && ring.length > 0) {
    out.push(Canvas.Close())
  }
  return out
}

const PAVEMENT_ORDER = ['apron', 'structure', 'taxiway', 'runway'] as const
const PAVEMENT_FILL: Readonly<Record<string, string>> = {
  apron: COLOURS.paveStructure,
  structure: COLOURS.paveStructure,
  taxiway: COLOURS.paveTaxiway,
  runway: COLOURS.paveRunway,
  hold: COLOURS.paveTaxiway,
}

const pavementShapes = (graph: Graph, view: ScopeView, map: VideoMap, asdex: boolean, unit: number): ReadonlyArray<Canvas.Shape> => {
  if (asdex) {
    return PAVEMENT_ORDER.map((cat) => {
      const instructions = map.features
        .filter((f) => (f.asdex ?? 'other') === cat)
        .flatMap((f) => f.polygons.flatMap((rings) => rings.flatMap((ring) => ringInstructions(graph, view, ring, true))))
      return Canvas.Path({ instructions, fill: PAVEMENT_FILL[cat] ?? COLOURS.paveStructure })
    })
  }
  const shapes: Array<Canvas.Shape> = []
  for (const f of map.features) {
    if (f.polygons.length > 0) {
      shapes.push(
        Canvas.Path({
          instructions: f.polygons.flatMap((rings) => rings.flatMap((ring) => ringInstructions(graph, view, ring, true))),
          fill: f.color ?? COLOURS.paveStructure,
        }),
      )
    }
    if (f.lines.length > 0) {
      shapes.push(
        Canvas.Path({
          instructions: f.lines.flatMap((line) => ringInstructions(graph, view, line, false)),
          stroke: f.color ?? COLOURS.net,
          lineWidth: Math.max(1, f.thickness ?? 1) * unit * 1.2 * view.scale,
        }),
      )
    }
  }
  return [Canvas.Group({ opacity: 0.35, shapes })]
}

const networkShapes = (graph: Graph, view: ScopeView, unit: number, colours: Accent): ReadonlyArray<Canvas.Shape> => {
  const taxi: Array<Canvas.PathInstruction> = []
  graph.adjacency.forEach((edges, a) => {
    for (const e of edges) {
      if (e.to < a || graph.runwayNames.includes(e.name)) {
        continue
      }
      const p = toCanvas(view, toWorld(graph, graph.nodes[a]!))
      const q = toCanvas(view, toWorld(graph, graph.nodes[e.to]!))
      taxi.push(Canvas.MoveTo({ x: p.x, y: p.y }), Canvas.LineTo({ x: q.x, y: q.y }))
    }
  })
  const runways: Array<Canvas.Shape> = []
  const labels: Array<Canvas.Shape> = []
  for (const [designator, end] of Object.entries(graph.runwayEnds)) {
    const points = end.chain.map((n) => toCanvas(view, toWorld(graph, graph.nodes[n]!)))
    runways.push(
      Canvas.Path({
        instructions: points.map((p, i) => (i === 0 ? Canvas.MoveTo({ x: p.x, y: p.y }) : Canvas.LineTo({ x: p.x, y: p.y }))),
        stroke: COLOURS.paveRunway,
        lineWidth: 3 * unit * view.scale,
        lineCap: 'Round',
      }),
    )
    const t = points[0]!
    labels.push(
      Canvas.Text({ x: t.x, y: t.y, content: designator, font: `600 ${(22 * unit * view.scale).toFixed(1)}px ${MONO}`, fill: COLOURS.ink3, align: 'Center', baseline: 'Middle' }),
    )
  }
  const gates = Object.values(graph.parking).map((g) => {
    const p = toCanvas(view, toWorld(graph, g.c))
    return Canvas.Group({
      opacity: g.spot ? 0.3 : 0.45,
      shapes: [Canvas.Circle({ x: p.x, y: p.y, radius: 3.2 * unit * view.scale, fill: g.spot ? colours.accent : COLOURS.net })],
    })
  })
  return [
    Canvas.Group({ opacity: 0.5, shapes: [Canvas.Path({ instructions: taxi, stroke: COLOURS.net, lineWidth: 2.4 * unit * view.scale })] }),
    Canvas.Group({ opacity: 0.55, shapes: runways }),
    Canvas.Group({ opacity: 0.85, shapes: labels }),
    ...gates,
  ]
}

type StaticKey = Readonly<{ graph: Graph; key: string; shapes: ReadonlyArray<Canvas.Shape> }>
let staticCache: StaticKey | null = null

const staticLayers = (graph: Graph, view: ScopeView, pavement: Readonly<{ id: string; asdex: boolean }> | null, colours: Accent): ReadonlyArray<Canvas.Shape> => {
  const key = `${view.width}|${view.height}|${view.scale}|${view.originX}|${view.originY}|${pavement?.id ?? ''}|${colours.accent}`
  if (staticCache !== null && staticCache.graph === graph && staticCache.key === key) {
    return staticCache.shapes
  }
  const unit = worldSize(graph).w / 1000
  const map = pavement === null ? undefined : videoMapById(pavement.id)
  const shapes = [
    Canvas.Rect({ x: 0, y: 0, width: view.width, height: view.height, fill: COLOURS.bg }),
    ...(map === undefined || pavement === null ? [] : pavementShapes(graph, view, map, pavement.asdex, unit)),
    ...networkShapes(graph, view, unit, colours),
  ]
  staticCache = { graph, key, shapes }
  return shapes
}

const aircraftShapes = (graph: Graph, view: ScopeView, a: Aircraft, selected: boolean, showTags: boolean): ReadonlyArray<Canvas.Shape> => {
  const { w } = worldSize(graph)
  const s = viewWidthFt(view) / w
  const size = (7.5 * view.width) / 1000 * (Math.max(0.55, Math.min(1.6, s)) / s)
  const font = Math.max((8 * w) / 1000, (11 * w) / 1000 * Math.max(0.6, Math.min(1.5, s))) * view.scale
  const c = toCanvas(view, toWorld(graph, a.position))
  const colour = STATE_COLOUR[a.state]
  const shapes: Array<Canvas.Shape> = []
  if (a.history.length > 1 && a.speed > 1) {
    a.history.slice(0, -1).forEach((h, i) => {
      const p = toCanvas(view, toWorld(graph, h))
      shapes.push(Canvas.Group({ opacity: 0.1 + 0.06 * i, shapes: [Canvas.Circle({ x: p.x, y: p.y, radius: size * 0.22, fill: colour })] }))
    })
  }
  if (selected) {
    shapes.push(Canvas.Group({ opacity: 0.85, shapes: [Canvas.Circle({ x: c.x, y: c.y, radius: size * 2.1, stroke: COLOURS.cyan, lineWidth: size * 0.22 })] }))
  }
  shapes.push(
    Canvas.Group({
      translate: { x: c.x, y: c.y },
      rotate: (a.heading * Math.PI) / 180,
      shapes: [
        Canvas.Path({
          instructions: [
            Canvas.MoveTo({ x: 0, y: -size }),
            Canvas.LineTo({ x: size * 0.74, y: size * 0.82 }),
            Canvas.LineTo({ x: 0, y: size * 0.46 }),
            Canvas.LineTo({ x: -size * 0.74, y: size * 0.82 }),
            Canvas.Close(),
          ],
          fill: colour,
          stroke: COLOURS.bg,
          lineWidth: size * 0.13,
        }),
      ],
    }),
  )
  if (showTags || selected || a.state !== 'PARKED') {
    const tx = c.x + size * 1.9
    const ty = c.y - size * 0.5
    const second =
      a.state === 'PARKED'
        ? `${a.type} ${a.gate ?? ''}`
        : a.runway !== null
          ? `${a.type} ${a.runway}`
          : `${a.type}${a.destinationGate !== null ? ' ' + a.destinationGate : ''}`
    shapes.push(
      Canvas.Text({ x: tx, y: ty, content: a.callsign, font: `600 ${font.toFixed(1)}px ${MONO}`, fill: selected ? COLOURS.cyan : COLOURS.ink, align: 'Left', baseline: 'Alphabetic' }),
      Canvas.Text({ x: tx, y: ty + font * 1.12, content: second, font: `${(font * 0.86).toFixed(1)}px ${MONO}`, fill: COLOURS.ink3, align: 'Left', baseline: 'Alphabetic' }),
    )
  }
  return shapes
}

export const accentFor = (mode: 'ground' | 'tower'): string => (mode === 'tower' ? '#b388ff' : COLOURS.amber)

const scopeCanvas = (model: Model, h: HtmlBuilder<Message>): Html => {
  const world = worldOf(model)
  const view = model.scope
  const dpr = model.devicePixelRatio
  if (world === null) {
    return h.empty
  }
  const graph = world.graph
  const pavement = model.pavement._tag === 'Ready' ? { id: model.pavement.id, asdex: model.pavement.asdex } : null
  const showTags = viewWidthFt(view) < worldSize(graph).w * 0.62
  const shapes: ReadonlyArray<Canvas.Shape> = [
    Canvas.Group({
      scale: { x: dpr, y: dpr },
      shapes: [
        ...staticLayers(graph, view, pavement, { accent: accentFor(model.settings.mode) }),
        ...world.aircraft.filter((a) => a.delay <= 0).flatMap((a) => aircraftShapes(graph, view, a, a.callsign === model.selected, showTags)),
      ],
    }),
  ]
  return Canvas.view(
    {
      width: Math.max(1, Math.round(view.width * dpr)),
      height: Math.max(1, Math.round(view.height * dpr)),
      shapes,
      className: `scope-canvas${model.drag !== null && model.drag.moved ? ' drag' : ''}`,
      onPointerDown: ({ x, y }) => Message.PressedScope({ x: x / dpr, y: y / dpr }),
      onPointerMove: ({ x, y }) => Message.MovedScope({ x: x / dpr, y: y / dpr }),
      onPointerUp: ({ x, y }) => Message.ReleasedScope({ x: x / dpr, y: y / dpr }),
    },
    h,
  )
}

const overlayText = (model: Model): Readonly<{ text: string; error: boolean }> | null => {
  if (model.index._tag === 'Loading') {
    return { text: model.settings.proxy !== '' ? 'loading live from vNAS via proxy…' : 'loading catalog…', error: false }
  }
  if (model.index._tag === 'Failed') {
    return {
      text:
        model.settings.proxy !== ''
          ? `could not reach vNAS through the proxy: ${model.index.error} — check the proxy URL in Settings, or clear it to use the catalog`
          : `no catalog found (${model.index.error}) — run "bun run catalog" before serving this folder, or set a vNAS proxy in Settings`,
      error: true,
    }
  }
  if (model.airport._tag === 'Loading') {
    return { text: `loading ${model.airport.id}…`, error: false }
  }
  if (model.airport._tag === 'Failed') {
    return { text: `could not load ${model.airport.id}: ${model.airport.error}`, error: true }
  }
  if (model.scenarioLoading !== null) {
    return { text: 'loading scenario…', error: false }
  }
  return null
}

const LEGEND: ReadonlyArray<readonly [string, string]> = [
  [COLOURS.ink3, 'at the gate'],
  [COLOURS.violet, 'pushback'],
  [COLOURS.green, 'taxiing'],
  [COLOURS.amber, 'holding short'],
  [COLOURS.red, 'stopped'],
  [COLOURS.cyan, 'runway / airborne'],
]

export const scopeView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const world = worldOf(model)
  const overlay = overlayText(model)
  const active = world === null ? 0 : world.aircraft.filter((a) => a.delay <= 0).length
  const pending = world === null ? 0 : world.aircraft.filter((a) => a.delay > 0).length
  const moving = world === null ? 0 : world.aircraft.filter((a) => a.delay <= 0 && (a.state === 'TAXI' || a.state === 'PUSH')).length
  return h.div(
    [h.Class('scope'), h.OnMount(ScopeSurface())],
    [
      scopeCanvas(model, h),
      h.div(
        [h.Class('scope-keys')],
        LEGEND.map(([colour, label]) => h.span([], [h.i([h.Style({ background: colour })]), label])),
      ),
      world === null
        ? h.empty
        : h.div(
            [h.Class('scope-hud')],
            [`${world.airport.id} · ${active} aircraft · ${moving} moving${pending > 0 ? ` · ${pending} pending` : ''}`, h.br([]), 'scroll to zoom · drag to pan'],
          ),
      h.div(
        [h.Class('zoombar')],
        [
          h.button([h.Type('button'), h.OnClick(Message.ClickedZoomIn()), h.AriaLabel('Zoom in')], ['+']),
          h.button([h.Type('button'), h.OnClick(Message.ClickedZoomOut()), h.AriaLabel('Zoom out')], ['−']),
          h.button([h.Type('button'), h.Class('fit'), h.OnClick(Message.ClickedFit()), h.AriaLabel('Fit airport')], ['FIT']),
        ],
      ),
      overlay === null ? h.empty : h.div([h.Class(`overlay${overlay.error ? ' err' : ''}`)], [h.div([], [overlay.text])]),
    ],
  )
}
