/**
 * The ground scope on a Foldkit Canvas: ASDE-X pavement (or the tower-cab map),
 * the centreline network, runways with designators, gates, and aircraft with
 * trails and labels. Static layers are memoised per viewport because the Canvas
 * repaints the whole shape list on every render.
 */
import { Canvas } from 'foldkit'
import { type Html, type HtmlBuilder, createLazy, inertHtml as ih } from 'foldkit/html'

import { videoMapById } from '../app/mapCache'
import { type Model, type ScopeView, infoOf, worldOf } from '../app/model'
import { Message } from '../app/message'
import { ScopeSurface } from '../app/commands'
import type { Aircraft, AircraftState } from '../domain/aircraft'
import { type Graph, runwayEntries } from '../domain/graph'
import { type Ring, type VideoMap, type VideoMapFeature, cabLayerKey, cabLayers } from '../domain/videomap'
import { departureProcedure } from '../domain/vnas'
import { fullLengthEntry, intersections } from '../app/plan'
import { type OpenPlan, openPlan } from '../app/radial'
import { radialView, runwayButtonsView } from './radial'
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

export const DECIMATE_PX = 0.75

/**
 * Path instructions for projected points, dropping points that land within a
 * pixel of the last kept one and whole rings outside the canvas. Video maps
 * carry far more vertices than a scope can show.
 */
export const decimatedPath = (points: ReadonlyArray<Canvas.Point>, width: number, height: number, close: boolean): Array<Canvas.PathInstruction> => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  if (points.length === 0 || maxX < 0 || maxY < 0 || minX > width || minY > height) {
    return []
  }
  const out: Array<Canvas.PathInstruction> = []
  let last: Canvas.Point | null = null
  points.forEach((p, i) => {
    const isLast = i === points.length - 1
    if (last !== null && !isLast && Math.abs(p.x - last.x) < DECIMATE_PX && Math.abs(p.y - last.y) < DECIMATE_PX) {
      return
    }
    out.push(last === null ? Canvas.MoveTo({ x: p.x, y: p.y }) : Canvas.LineTo({ x: p.x, y: p.y }))
    last = p
  })
  if (close && out.length > 1) {
    out.push(Canvas.Close())
  }
  return out
}

/** Path instructions from a flat [x0, y0, x1, y1, …] array of world-feet points. */
export const decimatedFlatPath = (flat: Float64Array, view: Readonly<{ scale: number; originX: number; originY: number; width: number; height: number }>, close: boolean): Array<Canvas.PathInstruction> => {
  const n = flat.length / 2
  if (n === 0) {
    return []
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const x = (flat[2 * i]! - view.originX) * view.scale
    const y = (flat[2 * i + 1]! - view.originY) * view.scale
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  if (maxX < 0 || maxY < 0 || minX > view.width || minY > view.height) {
    return []
  }
  const out: Array<Canvas.PathInstruction> = []
  let lastX = NaN
  let lastY = NaN
  for (let i = 0; i < n; i++) {
    const x = (flat[2 * i]! - view.originX) * view.scale
    const y = (flat[2 * i + 1]! - view.originY) * view.scale
    const isLast = i === n - 1
    if (i > 0 && !isLast && Math.abs(x - lastX) < DECIMATE_PX && Math.abs(y - lastY) < DECIMATE_PX) {
      continue
    }
    out.push(i === 0 ? Canvas.MoveTo({ x, y }) : Canvas.LineTo({ x, y }))
    lastX = x
    lastY = y
  }
  if (close && out.length > 1) {
    out.push(Canvas.Close())
  }
  return out
}

/** World-feet coordinates of every ring in a video map, computed once per map and graph. */
const worldRingCache = new WeakMap<VideoMap, WeakMap<Graph, ReadonlyArray<ReadonlyArray<Float64Array>>>>()
const worldRings = (map: VideoMap, graph: Graph): ReadonlyArray<ReadonlyArray<Float64Array>> => {
  const perGraph = worldRingCache.get(map) ?? new WeakMap<Graph, ReadonlyArray<ReadonlyArray<Float64Array>>>()
  const cached = perGraph.get(graph)
  if (cached !== undefined) {
    return cached
  }
  const flatten = (ring: Ring): Float64Array => {
    const flat = new Float64Array(ring.length * 2)
    ring.forEach((c, i) => {
      const p = toWorld(graph, c)
      flat[2 * i] = p.x
      flat[2 * i + 1] = p.y
    })
    return flat
  }
  const rings = map.features.map((f) => [...f.polygons.flatMap((polygon) => polygon.map(flatten)), ...f.lines.map(flatten)])
  perGraph.set(graph, rings)
  worldRingCache.set(map, perGraph)
  return rings
}

const PAVEMENT_ORDER = ['apron', 'structure', 'taxiway', 'runway'] as const
const PAVEMENT_FILL: Readonly<Record<string, string>> = {
  apron: COLOURS.paveStructure,
  structure: COLOURS.paveStructure,
  taxiway: COLOURS.paveTaxiway,
  runway: COLOURS.paveRunway,
  hold: COLOURS.paveTaxiway,
}

/** ASDE-X pavement by category, or a tower-cab map layer by layer in draw order, skipping the layers in `hidden`. */
const pavementShapes = (graph: Graph, view: ScopeView, map: VideoMap, asdex: boolean, unit: number, hidden: ReadonlySet<string>): ReadonlyArray<Canvas.Shape> => {
  const rings = worldRings(map, graph)
  const polygonCount = (f: VideoMapFeature) => f.polygons.reduce((n, polygon) => n + polygon.length, 0)
  if (asdex) {
    return PAVEMENT_ORDER.map((cat) => {
      const instructions = map.features.flatMap((f, fi) =>
        (f.asdex ?? 'other') === cat ? rings[fi]!.slice(0, polygonCount(f)).flatMap((flat) => decimatedFlatPath(flat, view, true)) : [],
      )
      return Canvas.Path({ instructions, fill: PAVEMENT_FILL[cat] ?? COLOURS.paveStructure })
    })
  }
  const shapes: Array<Canvas.Shape> = []
  const order = map.features.map((f, fi) => [f, fi] as const).sort((a, b) => (a[0].zIndex ?? 0) - (b[0].zIndex ?? 0))
  for (const [f, fi] of order) {
    const polygons = polygonCount(f)
    if (polygons > 0 && !hidden.has(cabLayerKey(f, 'fill'))) {
      shapes.push(
        Canvas.Path({
          instructions: rings[fi]!.slice(0, polygons).flatMap((flat) => decimatedFlatPath(flat, view, true)),
          fill: f.color ?? COLOURS.paveStructure,
        }),
      )
    }
    if (f.lines.length > 0 && !hidden.has(cabLayerKey(f, 'line'))) {
      shapes.push(
        Canvas.Path({
          instructions: rings[fi]!.slice(polygons).flatMap((flat) => decimatedFlatPath(flat, view, false)),
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

/** Pavement, network and gates: repainted only when the viewport, pavement, hidden layers or accent changes. `hidden` is the layer keys joined by `|`, a string so the memo compares it by value. */
const staticCanvas = (graph: Graph, view: ScopeView, pavementId: string | null, asdex: boolean, hidden: string, accent: string, dpr: number): Html => {
  const unit = worldSize(graph).w / 1000
  const map = pavementId === null ? undefined : videoMapById(pavementId)
  const shapes: ReadonlyArray<Canvas.Shape> = [
    Canvas.Group({
      scale: { x: dpr, y: dpr },
      shapes: [
        Canvas.Rect({ x: 0, y: 0, width: view.width, height: view.height, fill: COLOURS.bg }),
        ...(map === undefined ? [] : pavementShapes(graph, view, map, asdex, unit, new Set(hidden === '' ? [] : hidden.split('|')))),
        ...networkShapes(graph, view, unit, { accent }),
      ],
    }),
  ]
  return Canvas.view({ width: Math.max(1, Math.round(view.width * dpr)), height: Math.max(1, Math.round(view.height * dpr)), shapes, className: 'scope-static' }, ih)
}

const lazyStatic = createLazy()

/** `font` is the data block size in CSS px: a display setting, not a function of the zoom. */
const aircraftShapes = (graph: Graph, view: ScopeView, a: Aircraft, selected: boolean, showTags: boolean, font: number, accent: string): ReadonlyArray<Canvas.Shape> => {
  const { w } = worldSize(graph)
  const s = viewWidthFt(view) / w
  const size = (7.5 * view.width) / 1000 * (Math.max(0.55, Math.min(1.6, s)) / s)
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
          ? `${a.type} ${a.runway}${a.intersection !== null ? '/' + a.intersection : ''}`
          : `${a.type}${a.destinationGate !== null ? ' ' + a.destinationGate : ''}`
    const procedure = departureProcedure(a.flightPlan.sid, a.flightPlan.route)
    shapes.push(
      Canvas.Text({ x: tx, y: ty, content: a.callsign, font: `600 ${font.toFixed(1)}px ${MONO}`, fill: selected ? COLOURS.cyan : COLOURS.ink, align: 'Left', baseline: 'Alphabetic' }),
      Canvas.Text({ x: tx, y: ty + font * 1.12, content: second, font: `${(font * 0.86).toFixed(1)}px ${MONO}`, fill: COLOURS.ink3, align: 'Left', baseline: 'Alphabetic' }),
      ...(procedure === null
        ? []
        : [Canvas.Text({ x: tx, y: ty + font * 2.1, content: procedure, font: `${(font * 0.86).toFixed(1)}px ${MONO}`, fill: accent, align: 'Left', baseline: 'Alphabetic' })]),
    )
  }
  return shapes
}

export const accentFor = (mode: 'ground' | 'tower' | 'tracon'): string => (mode === 'tower' ? '#b388ff' : mode === 'tracon' ? '#2dd4bf' : COLOURS.amber)

/** Entry labels closer than this many px to the previous one along the runway are left off. */
export const ENTRY_LABEL_GAP_PX = 26

/**
 * The taxiways the planned runway can be entered from, marked on its centreline
 * with their names: the one the route ends at is ringed, the full-length one is
 * marked FULL. A click on a marker enters there (see `ReleasedScope`).
 */
const entryShapes = (graph: Graph, view: ScopeView, open: OpenPlan): ReadonlyArray<Canvas.Shape> => {
  const { preview, plan } = open
  const at = (n: number) => toCanvas(view, toWorld(graph, graph.nodes[n]!))
  const hold = preview.path === null ? null : preview.path[preview.path.length - 1]!
  const full = fullLengthEntry(graph, plan.runway)?.taxiway ?? null
  const shapes: Array<Canvas.Shape> = []
  let lastLabel: Canvas.Point | null = null
  for (const e of runwayEntries(graph, plan.runway)) {
    const p = at(e.node)
    if (p.x < -12 || p.y < -12 || p.x > view.width + 12 || p.y > view.height + 12) {
      continue
    }
    const chosen = hold !== null && e.holds.includes(hold)
    const colour = chosen ? COLOURS.cyan : COLOURS.ink3
    shapes.push(Canvas.Rect({ x: p.x - 3.5, y: p.y - 3.5, width: 7, height: 7, fill: chosen ? COLOURS.cyan : COLOURS.paveRunway, stroke: colour, lineWidth: 1.5 }))
    if (chosen) {
      shapes.push(Canvas.Circle({ x: p.x, y: p.y, radius: 8, stroke: COLOURS.cyan, lineWidth: 2 }))
    }
    const crowded = lastLabel !== null && Math.hypot(p.x - lastLabel.x, p.y - lastLabel.y) < ENTRY_LABEL_GAP_PX
    if (chosen || !crowded) {
      shapes.push(
        Canvas.Text({
          x: p.x + 10,
          y: p.y - 6,
          content: e.taxiway === full ? `${e.taxiway} FULL` : e.taxiway,
          font: `${chosen ? '600 ' : ''}10px ${MONO}`,
          fill: colour,
          align: 'Left',
          baseline: 'Alphabetic',
        }),
      )
      lastLabel = p
    }
  }
  return [Canvas.Group({ opacity: 0.9, shapes })]
}

/**
 * A proposed taxi clearance: the taxiways the runway can be entered from, the
 * intersections a click can send the route through (brighter on the route, ringed
 * when chosen), the route itself, and a marker at every runway it enters: amber
 * where the aircraft will hold short, green where the clearance lets it cross. A
 * click on a marker toggles it (see `ReleasedScope`).
 */
const planShapes = (graph: Graph, view: ScopeView, open: OpenPlan): ReadonlyArray<Canvas.Shape> => {
  const { preview, plan } = open
  const at = (n: number) => toCanvas(view, toWorld(graph, graph.nodes[n]!))
  const onRoute = new Set(preview.path ?? [])
  const dots = intersections(graph).flatMap((n) => {
    const p = at(n)
    if (p.x < -8 || p.y < -8 || p.x > view.width + 8 || p.y > view.height + 8) {
      return []
    }
    return [Canvas.Circle({ x: p.x, y: p.y, radius: onRoute.has(n) ? 4 : 3, fill: onRoute.has(n) ? COLOURS.ink : COLOURS.ink3, stroke: COLOURS.bg, lineWidth: 1 })]
  })
  const shapes: Array<Canvas.Shape> = [Canvas.Group({ opacity: 0.8, shapes: dots }), ...entryShapes(graph, view, open)]
  if (preview.path !== null) {
    const points = preview.path.map(at)
    shapes.push(
      Canvas.Group({
        opacity: 0.9,
        shapes: [
          Canvas.Path({
            instructions: points.map((p, i) => (i === 0 ? Canvas.MoveTo({ x: p.x, y: p.y }) : Canvas.LineTo({ x: p.x, y: p.y }))),
            stroke: COLOURS.amber,
            lineWidth: 3,
            lineCap: 'Round',
          }),
        ],
      }),
    )
    const end = points[points.length - 1]!
    shapes.push(Canvas.Circle({ x: end.x, y: end.y, radius: 5, stroke: COLOURS.amber, lineWidth: 2 }))
  }
  for (const n of plan.waypoints) {
    const p = at(n)
    shapes.push(Canvas.Circle({ x: p.x, y: p.y, radius: 6.5, stroke: COLOURS.cyan, lineWidth: 2 }))
  }
  for (const c of preview.crossings) {
    const p = at(c.node)
    const colour = c.cleared ? COLOURS.green : COLOURS.amber
    shapes.push(
      Canvas.Circle({ x: p.x, y: p.y, radius: 7, fill: colour, stroke: COLOURS.bg, lineWidth: 1.5 }),
      Canvas.Text({
        x: p.x + 11,
        y: p.y + 4,
        content: `${c.cleared ? 'CROSS' : 'HOLD SHORT'} ${c.runway}`,
        font: `600 11px ${MONO}`,
        fill: colour,
        align: 'Left',
        baseline: 'Alphabetic',
      }),
    )
  }
  return shapes
}

const scopeCanvas = (model: Model, h: HtmlBuilder<Message>): Html => {
  const world = worldOf(model)
  const view = model.scope
  const dpr = model.devicePixelRatio
  if (world === null) {
    return h.empty
  }
  const graph = world.graph
  const { asdexParkedTags, asdexTagSize } = model.settings
  const open = model.selected === model.radial?.callsign ? openPlan(world, model.settings.mode, model.radial) : null
  const shapes: ReadonlyArray<Canvas.Shape> = [
    Canvas.Group({
      scale: { x: dpr, y: dpr },
      shapes: [
        ...(open === null ? [] : planShapes(graph, view, open)),
        ...world.aircraft
          .filter((a) => a.delay <= 0)
          .flatMap((a) => aircraftShapes(graph, view, a, a.callsign === model.selected, asdexParkedTags, asdexTagSize, accentFor(model.settings.mode))),
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
      ...(model.drag === null ? {} : { onPointerMove: ({ x, y }: Canvas.Point) => Message.MovedScope({ x: x / dpr, y: y / dpr }) }),
      onPointerUp: ({ x, y }) => Message.ReleasedScope({ x: x / dpr, y: y / dpr }),
    },
    h,
  )
}

const staticScope = (model: Model, h: HtmlBuilder<Message>): Html => {
  const world = worldOf(model)
  if (world === null) {
    return h.empty
  }
  const pavementId = model.pavement._tag === 'Ready' ? model.pavement.id : null
  const asdex = model.pavement._tag === 'Ready' && model.pavement.asdex
  const hidden = pavementId === null || asdex ? '' : (model.settings.cabLayersOff[pavementId] ?? []).join('|')
  return lazyStatic(staticCanvas, [world.graph, model.scope, pavementId, asdex, hidden, accentFor(model.settings.mode), model.devicePixelRatio])
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

/** The DISP panel: what the scope draws and how a click behaves; each change is saved with the settings. */
const displayPanel = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (!model.asdexPanelOpen) {
    return h.empty
  }
  const s = model.settings
  const info = infoOf(model)
  const bothMaps = info !== null && info.asdex !== null && info.twrmap !== null
  return h.div(
    [h.Class('adisp')],
    [
      h.div([h.Class('grp')], ['ASDE-X display']),
      h.label(
        [h.Class(bothMaps ? '' : 'off'), h.Title(bothMaps ? 'draw the tower-cab artwork instead of the ASDE-X pavement' : 'this airport has only one map')],
        [h.input([h.Type('checkbox'), h.Checked(s.asdexCabMap), h.Disabled(!bothMaps), h.OnChange(() => Message.ToggledCabMap())]), 'tower-cab map instead of ASDE-X pavement'],
      ),
      h.label([], [h.input([h.Type('checkbox'), h.Checked(s.asdexParkedTags), h.OnChange(() => Message.ToggledParkedTags())]), 'data blocks on parked aircraft']),
      h.div(
        [h.Class('row')],
        [
          h.span([], ['data block size']),
          h.button([h.Type('button'), h.AriaLabel('Smaller'), h.OnClick(Message.ChangedTagSize({ delta: -1 }))], ['−']),
          h.b([], [`${s.asdexTagSize} px`]),
          h.button([h.Type('button'), h.AriaLabel('Larger'), h.OnClick(Message.ChangedTagSize({ delta: 1 }))], ['+']),
        ],
      ),
      ...cabLayerRows(model, h),
    ],
  )
}

/** One checkbox per layer of the tower-cab map on the scope: a swatch, fills or lines, and the feature count. */
const cabLayerRows = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  if (model.pavement._tag !== 'Ready' || model.pavement.asdex) {
    return []
  }
  const id = model.pavement.id
  const map = videoMapById(id)
  if (map === undefined) {
    return []
  }
  const off = model.settings.cabLayersOff[id] ?? []
  return [
    h.div([h.Class('grp layers')], ['tower-cab layers']),
    ...cabLayers(map).map((layer) =>
      h.label(
        [h.Class('layer')],
        [
          h.input([h.Type('checkbox'), h.Checked(!off.includes(layer.key)), h.OnChange(() => Message.ToggledCabLayer({ key: layer.key }))]),
          h.i([h.Class('sw'), h.Style({ background: layer.color ?? COLOURS.net })]),
          h.span([], [`${layer.kind === 'fill' ? 'fills' : 'lines'} ${layer.color ?? 'default'}`]),
          h.b([], [`z${layer.zIndex} · ${layer.count}`]),
        ],
      ),
    ),
  ]
}

/** `inset` is drawn in the top-left corner: the selected aircraft's strip (see `selectedStripView`). */
export const scopeView = (model: Model, h: HtmlBuilder<Message>, inset: Html = h.empty): Html => {
  const world = worldOf(model)
  const overlay = overlayText(model)
  const active = world === null ? 0 : world.aircraft.filter((a) => a.delay <= 0).length
  const pending = world === null ? 0 : world.aircraft.filter((a) => a.delay > 0).length
  const moving = world === null ? 0 : world.aircraft.filter((a) => a.delay <= 0 && (a.state === 'TAXI' || a.state === 'PUSH')).length
  return h.div(
    [h.Class('scope'), h.OnMount(ScopeSurface())],
    [
      staticScope(model, h),
      scopeCanvas(model, h),
      ...runwayButtonsView(model, h),
      radialView(model, h),
      inset,
      h.div(
        [h.Class('scope-keys')],
        LEGEND.map(([colour, label]) => h.span([], [h.i([h.Style({ background: colour })]), label])),
      ),
      world === null
        ? h.empty
        : h.div(
            [h.Class('scope-hud')],
            [`${world.airport.id} · ${active} aircraft · ${moving} moving${pending > 0 ? ` · ${pending} pending` : ''}`, h.br([]), 'scroll to zoom · drag to pan · right-click for commands'],
          ),
      h.div(
        [h.Class('zoombar')],
        [
          h.button([h.Type('button'), h.OnClick(Message.ClickedZoomIn()), h.AriaLabel('Zoom in')], ['+']),
          h.button([h.Type('button'), h.OnClick(Message.ClickedZoomOut()), h.AriaLabel('Zoom out')], ['−']),
          h.button([h.Type('button'), h.Class('fit'), h.OnClick(Message.ClickedFit()), h.AriaLabel('Fit airport')], ['FIT']),
          h.button(
            [h.Type('button'), h.Class('fit adisp-btn'), h.AriaPressed(model.asdexPanelOpen ? 'true' : 'false'), h.OnClick(Message.ClickedAsdexPanel()), h.AriaLabel('Display settings')],
            ['DISP'],
          ),
        ],
      ),
      displayPanel(model, h),
      overlay === null ? h.empty : h.div([h.Class(`overlay${overlay.error ? ' err' : ''}`)], [h.div([], [overlay.text])]),
    ],
  )
}
