/**
 * The STARS radar pane (Local position): range rings, the field's runways, the
 * selected video maps, and one radar return per second per target with a trail
 * and a data block. A Submodel view over StarsModel with the world as input.
 */
import { Canvas, Submodel } from 'foldkit'
import { type Html, type HtmlBuilder, createLazy, inertHtml as ih } from 'foldkit/html'

import { videoMapById } from '../app/mapCache'
import type { LonLat, Stars } from '../domain/catalog'
import type { Graph } from '../domain/graph'
import { strokeRings } from '../domain/videomap'
import type { World } from '../domain/world'
import { type RadarPoint, StarsMessage, type StarsModel, StarsSurface, canvasToNm, pxPerNm, radarPoint, toCanvas } from '../positions/local/stars'
import { COLOURS, decimatedFlatPath } from './scope'
import type { VideoMap } from '../domain/videomap'

/** The static picture depends only on these; the world's graph and centre are referentially stable across ticks. */
type Field = Readonly<{ graph: Graph; radarCenter: LonLat | null }>
const fieldPoint = (field: Field, c: LonLat): RadarPoint => radarPoint({ graph: field.graph, airport: { radarCenter: field.radarCenter } } as World, c)

export type StarsInputs = Readonly<{
  world: World | null
  stars: Stars | null
  selected: string | null
  devicePixelRatio: number
  accent: string
}>

const MONO = '"IBM Plex Mono", Menlo, monospace'
const MAP_COLOUR = '#3a7a90'
const RADAR_BG = '#07090b'

const ringShapes = (model: StarsModel): ReadonlyArray<Canvas.Shape> => {
  const s = pxPerNm(model)
  const c = toCanvas(model, 0, 0)
  const rings: Array<Canvas.Shape> = []
  for (let r = 5; r <= 60; r += 5) {
    rings.push(
      Canvas.Group({
        opacity: r % 10 ? 0.35 : 0.6,
        shapes: [Canvas.Circle({ x: c.x, y: c.y, radius: r * s, stroke: '#2a343a', lineWidth: r % 10 ? 0.6 : 1 })],
      }),
    )
  }
  return rings
}

const runwayShapes = (model: StarsModel, field: Field): ReadonlyArray<Canvas.Shape> =>
  Object.values(field.graph.runwayEnds).map((end) => {
    const points = end.chain.map((n) => {
      const p = fieldPoint(field, field.graph.nodes[n]!)
      return toCanvas(model, p.x, p.y)
    })
    return Canvas.Group({
      opacity: 0.8,
      shapes: [
        Canvas.Path({
          instructions: points.map((p, i) => (i === 0 ? Canvas.MoveTo({ x: p.x, y: p.y }) : Canvas.LineTo({ x: p.x, y: p.y }))),
          stroke: COLOURS.ink3,
          lineWidth: 2,
        }),
      ],
    })
  })

/** Radar-plane (nm) coordinates of every stroked ring, computed once per map and field. */
const nmRingCache = new WeakMap<VideoMap, WeakMap<Field, ReadonlyArray<Float64Array>>>()
const nmRings = (map: VideoMap, field: Field): ReadonlyArray<Float64Array> => {
  const perField = nmRingCache.get(map) ?? new WeakMap<Field, ReadonlyArray<Float64Array>>()
  const cached = perField.get(field)
  if (cached !== undefined) {
    return cached
  }
  const rings = strokeRings(map).map((ring) => {
    const flat = new Float64Array(ring.length * 2)
    ring.forEach((c, i) => {
      const p = fieldPoint(field, c)
      flat[2 * i] = p.x
      flat[2 * i + 1] = p.y
    })
    return flat
  })
  perField.set(field, rings)
  nmRingCache.set(map, perField)
  return rings
}

/** The radar view as a scale/origin transform, so map rings share the ground scope's path builder. */
const radarTransform = (model: StarsModel) => {
  const scale = pxPerNm(model)
  const origin = canvasToNm(model, 0, 0)
  return { scale, originX: origin.x, originY: origin.y, width: model.width, height: model.height }
}

const mapShapes = (model: StarsModel, field: Field, stars: Stars | null): ReadonlyArray<Canvas.Shape> => {
  const transform = radarTransform(model)
  return model.shown.flatMap((id) => {
    const map = videoMapById(id)
    const meta = stars?.maps.find((m) => m.id === id)
    if (map === undefined || !model.loaded.includes(id)) {
      return []
    }
    const instructions = nmRings(map, field).flatMap((flat) => decimatedFlatPath(flat, transform, false))
    return [Canvas.Group({ opacity: meta?.b === 'A' ? 0.85 : 0.5, shapes: [Canvas.Path({ instructions, stroke: MAP_COLOUR, lineWidth: 1 })] })]
  })
}

/** The selected aircraft's remaining route: a line through its fixes with their names, and its approach runway's final course. */
const routeShapes = (model: StarsModel, world: World, selected: string | null): ReadonlyArray<Canvas.Shape> => {
  const a = selected === null ? undefined : world.aircraft.find((x) => x.callsign === selected)
  if (a === undefined || a.state !== 'AIRB') {
    return []
  }
  const shapes: Array<Canvas.Shape> = []
  const start = radarPoint(world, a.position)
  const points = [toCanvas(model, start.x, start.y)]
  for (const name of a.fixes) {
    const c = world.nav.fixes[name]
    if (c === undefined) {
      continue
    }
    const p = radarPoint(world, c)
    const q = toCanvas(model, p.x, p.y)
    points.push(q)
    shapes.push(Canvas.Text({ x: q.x + 5, y: q.y - 4, content: name, font: `10px ${MONO}`, fill: COLOURS.cyan, align: 'Left', baseline: 'Alphabetic' }))
    shapes.push(Canvas.Circle({ x: q.x, y: q.y, radius: 2.5, stroke: COLOURS.cyan, lineWidth: 1 }))
  }
  if (points.length > 1) {
    shapes.push(
      Canvas.Group({
        opacity: 0.6,
        shapes: [Canvas.Path({ instructions: points.map((p, i) => (i === 0 ? Canvas.MoveTo({ x: p.x, y: p.y }) : Canvas.LineTo({ x: p.x, y: p.y }))), stroke: COLOURS.cyan, lineWidth: 1 })],
      }),
    )
  }
  return shapes
}

const targetShapes = (model: StarsModel, world: World, selected: string | null, accent: string): ReadonlyArray<Canvas.Shape> => {
  const size = 4
  const font = 11
  const shapes: Array<Canvas.Shape> = [...routeShapes(model, world, selected)]
  for (const a of world.aircraft) {
    const r = a.radar
    if (r === null) {
      continue
    }
    const p = radarPoint(world, r.position)
    const c = toCanvas(model, p.x, p.y)
    const colour = a.handoff ? accent : a.tracked ? COLOURS.green : '#8496a0'
    const isSelected = a.callsign === selected
    r.history.forEach((h, i) => {
      const hp = radarPoint(world, h)
      const hc = toCanvas(model, hp.x, hp.y)
      shapes.push(Canvas.Group({ opacity: 0.15 + 0.12 * i, shapes: [Canvas.Circle({ x: hc.x, y: hc.y, radius: size * 0.35, fill: colour })] }))
    })
    if (isSelected) {
      shapes.push(Canvas.Group({ opacity: 0.9, shapes: [Canvas.Circle({ x: c.x, y: c.y, radius: size * 2.4, stroke: COLOURS.cyan, lineWidth: size * 0.25 })] }))
    }
    shapes.push(
      Canvas.Group({
        translate: { x: c.x, y: c.y },
        rotate: Math.PI / 4,
        shapes: [
          a.tracked
            ? Canvas.Rect({ x: -size, y: -size, width: 2 * size, height: 2 * size, fill: colour, stroke: colour, lineWidth: size * 0.3 })
            : Canvas.Rect({ x: -size, y: -size, width: 2 * size, height: 2 * size, stroke: colour, lineWidth: size * 0.3 }),
        ],
      }),
    )
    const lx = c.x + size * 3.2
    const ly = c.y - size * 3.2
    shapes.push(
      Canvas.Group({
        opacity: 0.8,
        shapes: [Canvas.Path({ instructions: [Canvas.MoveTo({ x: c.x + size, y: c.y - size }), Canvas.LineTo({ x: lx, y: ly })], stroke: colour, lineWidth: size * 0.2 })],
      }),
    )
    const alt3 = String(Math.max(0, Math.round(r.altitude / 100))).padStart(3, '0')
    const spd2 = String(Math.round(r.speed / 10)).padStart(2, '0')
    const departing = a.departure !== null && a.departure.endsWith(world.airport.id)
    const scratch =
      a.state === 'FINAL' || a.goingAround || (a.state === 'AIRB' && !departing && a.runway !== null)
        ? (a.runway ?? '')
        : a.flightPlan.sid !== null && departing
          ? a.flightPlan.sid.slice(0, 3)
          : a.type
    const lines = a.tracked ? [`${a.handoff ? 'H/' : ''}${a.callsign}`, `${alt3} ${spd2}`, scratch] : [a.squawk, alt3]
    lines.forEach((text, i) => {
      shapes.push(
        Canvas.Text({
          x: lx + size * 0.4,
          y: ly + font * (i + 0.85),
          content: text,
          font: `${i === 0 && a.tracked ? '600 ' : ''}${font}px ${MONO}`,
          fill: isSelected ? COLOURS.cyan : colour,
          align: 'Left',
          baseline: 'Alphabetic',
        }),
      )
    })
  }
  return shapes
}

/** Maps, rings and runways: repainted only when the view, size, map set or field changes. */
const staticCanvas = (
  view: StarsModel['view'],
  width: number,
  height: number,
  shown: StarsModel['shown'],
  loaded: StarsModel['loaded'],
  field: Field | null,
  stars: Stars | null,
  dpr: number,
): Html => {
  const model: StarsModel = { view, width, height, shown, loaded, drag: null, mapsOpen: false }
  const shapes: ReadonlyArray<Canvas.Shape> = [
    Canvas.Group({
      scale: { x: dpr, y: dpr },
      shapes: [
        Canvas.Rect({ x: 0, y: 0, width, height, fill: RADAR_BG }),
        ...(field === null ? [] : mapShapes(model, field, stars)),
        ...ringShapes(model),
        ...(field === null ? [] : runwayShapes(model, field)),
      ],
    }),
  ]
  return Canvas.view({ width: Math.max(1, Math.round(width * dpr)), height: Math.max(1, Math.round(height * dpr)), shapes, className: 'stars-static' }, ih)
}

const lazyStatic = createLazy()

const radarCanvas = (model: StarsModel, inputs: StarsInputs, h: HtmlBuilder<StarsMessage>): Html => {
  const dpr = inputs.devicePixelRatio
  const world = inputs.world
  const shapes: ReadonlyArray<Canvas.Shape> = [
    Canvas.Group({
      scale: { x: dpr, y: dpr },
      shapes: world === null ? [] : targetShapes(model, world, inputs.selected, inputs.accent),
    }),
  ]
  return Canvas.view(
    {
      width: Math.max(1, Math.round(model.width * dpr)),
      height: Math.max(1, Math.round(model.height * dpr)),
      shapes,
      className: 'stars-canvas',
      onPointerDown: ({ x, y }) => StarsMessage.Pressed({ x: x / dpr, y: y / dpr }),
      ...(model.drag === null ? {} : { onPointerMove: ({ x, y }: Canvas.Point) => StarsMessage.Moved({ x: x / dpr, y: y / dpr }) }),
      onPointerUp: ({ x, y }) => StarsMessage.Released({ x: x / dpr, y: y / dpr }),
    },
    h,
  )
}

const fields = new WeakMap<Graph, Field>()
/** One Field per graph so the lazy static layer sees a stable argument. */
const fieldOf = (world: World): Field => {
  const cached = fields.get(world.graph)
  if (cached !== undefined && cached.radarCenter === world.airport.radarCenter) {
    return cached
  }
  const field: Field = { graph: world.graph, radarCenter: world.airport.radarCenter }
  fields.set(world.graph, field)
  return field
}

const mapsPanel = (model: StarsModel, stars: Stars | null, h: HtmlBuilder<StarsMessage>): Html => {
  if (stars === null) {
    return h.div([h.Class('smaps')], [h.div([h.Class('grp')], ['no STARS maps'])])
  }
  const inDef = new Set(stars.def)
  const def = stars.def.flatMap((id) => {
    const m = stars.maps.find((x) => x.id === id)
    return m === undefined ? [] : [m]
  })
  const rest = stars.maps.filter((m) => !inDef.has(m.id) && !m.tdm)
  const row = (m: Stars['maps'][number], dcb: boolean): Html =>
    h.label(
      [h.Class(dcb ? 'dcb' : '')],
      [
        h.input([h.Type('checkbox'), h.Checked(model.shown.includes(m.id)), h.OnChange(() => StarsMessage.ToggledMap({ id: m.id }))]),
        h.b([], [m.sid >= 0 ? String(m.sid) : '']),
        ` ${m.sn || m.n}`,
        m.av ? h.i([], [' always']) : h.empty,
      ],
    )
  return h.div(
    [h.Class('smaps')],
    [
      h.div([h.Class('grp')], [`${stars.host} · tower DCB${stars.tcp !== null ? ` (${stars.tcp})` : ''}`]),
      ...def.map((m) => row(m, true)),
      ...(rest.length > 0 ? [h.div([h.Class('grp')], [`other maps (${rest.length})`]), ...rest.map((m) => row(m, false))] : []),
    ],
  )
}

const LEGEND: ReadonlyArray<readonly [string, string]> = [
  ['#8496a0', 'untracked · beacon + alt'],
  [COLOURS.green, 'tracked · TRACK'],
  ['accent', 'handoff · CD'],
  [MAP_COLOUR, 'video map'],
]

export const starsView = Submodel.defineView<StarsModel, StarsMessage, StarsInputs>((model, inputs, h) => {
  const stars = inputs.stars
  const world = inputs.world
  const targets = world === null ? 0 : world.aircraft.filter((a) => a.radar !== null).length
  const hud1 = `${stars !== null ? `${stars.host} STARS${stars.tcp !== null ? ' · TCP ' + stars.tcp : ''}` : 'no STARS configuration for this airport'} · ${(model.view.w / 2).toFixed(0)} nm`
  const hud2 = `${stars?.dep ? `departure ${stars.dep.radio || stars.dep.cs} ${stars.dep.freq}` : 'no departure position found'} · targets ${targets}`
  return h.div(
    [h.Class('stars'), h.OnMount(StarsSurface())],
    [
      lazyStatic(staticCanvas, [model.view, model.width, model.height, model.shown, model.loaded, world === null ? null : fieldOf(world), stars, inputs.devicePixelRatio]),
      radarCanvas(model, inputs, h),
      h.div(
        [h.Class('sbar')],
        [
          h.button([h.Type('button'), h.OnClick(StarsMessage.ClickedMaps())], ['MAPS']),
          h.button([h.Type('button'), h.AriaLabel('Range down'), h.OnClick(StarsMessage.ClickedRangeIn())], ['RNG−']),
          h.button([h.Type('button'), h.AriaLabel('Range up'), h.OnClick(StarsMessage.ClickedRangeOut())], ['RNG+']),
          h.button([h.Type('button'), h.AriaLabel('Recentre'), h.OnClick(StarsMessage.ClickedCentre())], ['CTR']),
        ],
      ),
      model.mapsOpen ? mapsPanel(model, stars, h) : h.empty,
      h.div(
        [h.Class('scope-keys')],
        LEGEND.map(([colour, label]) => h.span([], [h.i([h.Style({ background: colour === 'accent' ? inputs.accent : colour })]), label])),
      ),
      h.div([h.Class('scope-hud')], [hud1, h.br([]), hud2]),
    ],
  )
})
