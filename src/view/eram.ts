/**
 * The ERAM display (Center position): the GeoMap's lines, symbols and text under
 * the filters switched on, then targets as ERAM draws them (a beacon slash with
 * history, the track's position symbol, a leader to a full data block or a
 * limited one beside the slash, velocity vectors, halos and route displays), the
 * GeoMap toolbar, the time view, the MCA feedback and the Response Area. A
 * Submodel view over EramModel with the world and the ARTCC file as inputs.
 */
import { Canvas, Submodel } from 'foldkit'
import { type Html, type HtmlBuilder, createLazy, inertHtml as ih } from 'foldkit/html'

import { videoMapById } from '../app/mapCache'
import { type Aircraft, handoffAccepted } from '../domain/aircraft'
import type { ArtccFile, GeoMap, LonLat } from '../domain/catalog'
import type { Graph } from '../domain/graph'
import { type VideoMap, type VideoMapFeature, eramFeatureVisible } from '../domain/videomap'
import type { World } from '../domain/world'
import { type RadarPoint, canvasToNm, pxPerNm, radarPoint, toCanvas } from '../positions/local/stars'
import { type BlockState, type EramModel, EramMessage, HALO_NM, LEADER_PX, defaultBlock, geoMapById, mapsToShow, routesShown } from '../positions/center/eram'
import { StarsSurface } from '../positions/local/stars'
import { decimatedFlatPath } from './scope'

export type EramInputs = Readonly<{
  world: World | null
  artcc: ArtccFile | null
  selected: string | null
  devicePixelRatio: number
}>

const MONO = '"IBM Plex Mono", Menlo, monospace'
const FONT_PX = 12
const LINE_PX = 13

/** ERAM's palette as CRC shows it: a near-black ground, blue-grey maps, yellow tracks. */
export const ERAM = {
  bg: '#02040f',
  map: '#3d4d63',
  mapBright: '#5a6d88',
  text: '#6f7f97',
  fdb: '#e6dc5a',
  fdbDim: '#a8a24a',
  ldb: '#9a9448',
  target: '#c9c24f',
  history: '#6c6a34',
  selected: '#f6f3d8',
  vci: '#46d46f',
  route: '#d8ce48',
  halo: '#c9c24f',
}

type Field = Readonly<{ graph: Graph; radarCenter: LonLat | null }>
const fieldPoint = (field: Field, c: LonLat): RadarPoint => radarPoint({ graph: field.graph, airport: { radarCenter: field.radarCenter } } as World, c)

const fields = new WeakMap<Graph, Field>()
const fieldOf = (world: World): Field => {
  const cached = fields.get(world.graph)
  if (cached !== undefined && cached.radarCenter === world.airport.radarCenter) {
    return cached
  }
  const field: Field = { graph: world.graph, radarCenter: world.airport.radarCenter }
  fields.set(world.graph, field)
  return field
}

// GEOMAP GEOMETRY

/** A feature's geometry on the radar plane (nm): its lines as flat arrays and its points. */
type Projected = Readonly<{ feature: VideoMapFeature; lines: ReadonlyArray<Float64Array>; points: Float64Array }>

const projectedCache = new WeakMap<VideoMap, WeakMap<Field, ReadonlyArray<Projected>>>()
const projected = (map: VideoMap, field: Field): ReadonlyArray<Projected> => {
  const perField = projectedCache.get(map) ?? new WeakMap<Field, ReadonlyArray<Projected>>()
  const cached = perField.get(field)
  if (cached !== undefined) {
    return cached
  }
  const out = map.features.map((feature): Projected => {
    const lines = [...feature.lines, ...feature.polygons.flat()].map((ring) => {
      const flat = new Float64Array(ring.length * 2)
      ring.forEach((c, i) => {
        const p = fieldPoint(field, c)
        flat[2 * i] = p.x
        flat[2 * i + 1] = p.y
      })
      return flat
    })
    const points = new Float64Array(feature.points.length * 2)
    feature.points.forEach((c, i) => {
      const p = fieldPoint(field, c)
      points[2 * i] = p.x
      points[2 * i + 1] = p.y
    })
    return { feature, lines, points }
  })
  perField.set(field, out)
  projectedCache.set(map, perField)
  return out
}

const radarTransform = (model: EramModel) => {
  const scale = pxPerNm(model)
  const origin = canvasToNm(model, 0, 0)
  return { scale, originX: origin.x, originY: origin.y, width: model.width, height: model.height }
}

const DASHES: Readonly<Record<string, ReadonlyArray<number>>> = {
  LongDashed: [9, 5],
  ShortDashed: [3, 3],
  LongDashShortDash: [9, 4, 2, 4],
}

/** A path's straight segments cut into a dash pattern (the Canvas has no dash setting). */
const dashed = (instructions: ReadonlyArray<Canvas.PathInstruction>, pattern: ReadonlyArray<number>): Array<Canvas.PathInstruction> => {
  const out: Array<Canvas.PathInstruction> = []
  let x = 0
  let y = 0
  let phase = 0
  let on = true
  let remaining = pattern[0] ?? 4
  for (const step of instructions) {
    if (step._tag === 'MoveTo') {
      x = step.x
      y = step.y
      continue
    }
    if (step._tag !== 'LineTo') {
      continue
    }
    let sx = x
    let sy = y
    const len = Math.hypot(step.x - x, step.y - y)
    let left = len
    while (left > 0) {
      const take = Math.min(left, remaining)
      const ex = sx + ((step.x - sx) * take) / Math.max(left, 1e-9)
      const ey = sy + ((step.y - sy) * take) / Math.max(left, 1e-9)
      if (on) {
        out.push(Canvas.MoveTo({ x: sx, y: sy }), Canvas.LineTo({ x: ex, y: ey }))
      }
      left -= take
      remaining -= take
      sx = ex
      sy = ey
      if (remaining <= 0) {
        phase = (phase + 1) % pattern.length
        remaining = pattern[phase] ?? 4
        on = phase % 2 === 0
      }
    }
    x = step.x
    y = step.y
  }
  return out
}

/** ERAM map symbols by their style name, drawn about the origin. */
const symbolShapes = (style: string | null, size: number, colour: string): ReadonlyArray<Canvas.Shape> => {
  const r = 3 + size
  const w = 1
  switch (style) {
    case 'VOR':
    case 'TACAN': {
      const hex = Array.from({ length: 6 }, (_, i) => ({ x: r * Math.cos((Math.PI / 3) * i), y: r * Math.sin((Math.PI / 3) * i) }))
      return [
        Canvas.Path({ instructions: [...hex.map((p, i) => (i === 0 ? Canvas.MoveTo(p) : Canvas.LineTo(p))), Canvas.Close()], stroke: colour, lineWidth: w }),
        Canvas.Circle({ x: 0, y: 0, radius: 1, fill: colour }),
      ]
    }
    case 'NDB':
      return [Canvas.Circle({ x: 0, y: 0, radius: r * 0.8, stroke: colour, lineWidth: w }), Canvas.Circle({ x: 0, y: 0, radius: 1, fill: colour })]
    case 'Airport':
    case 'Heliport':
      return [Canvas.Circle({ x: 0, y: 0, radius: r * 0.7, stroke: colour, lineWidth: w })]
    case 'Radar':
      return [Canvas.Circle({ x: 0, y: 0, radius: r * 0.6, stroke: colour, lineWidth: w }), Canvas.Path({ instructions: [Canvas.MoveTo({ x: -r, y: 0 }), Canvas.LineTo({ x: r, y: 0 }), Canvas.MoveTo({ x: 0, y: -r }), Canvas.LineTo({ x: 0, y: r })], stroke: colour, lineWidth: w })]
    case 'Nuclear':
      return [Canvas.Circle({ x: 0, y: 0, radius: r * 0.6, stroke: colour, lineWidth: w }), Canvas.Circle({ x: 0, y: 0, radius: 1.5, fill: colour })]
    case 'Obstruction1':
    case 'Obstruction2':
      return [Canvas.Path({ instructions: [Canvas.MoveTo({ x: -r * 0.6, y: r * 0.6 }), Canvas.LineTo({ x: 0, y: -r }), Canvas.LineTo({ x: r * 0.6, y: r * 0.6 })], stroke: colour, lineWidth: w })]
    case 'RNAV':
    case 'RNAVOnlyWaypoint':
    case 'IAF':
      return [Canvas.Path({ instructions: [Canvas.MoveTo({ x: 0, y: -r }), Canvas.LineTo({ x: r, y: 0 }), Canvas.LineTo({ x: 0, y: r }), Canvas.LineTo({ x: -r, y: 0 }), Canvas.Close()], stroke: colour, lineWidth: w })]
    case 'AirwayIntersections':
    case 'OtherWaypoints':
    default:
      return [Canvas.Path({ instructions: [Canvas.MoveTo({ x: 0, y: -r }), Canvas.LineTo({ x: r * 0.87, y: r * 0.5 }), Canvas.LineTo({ x: -r * 0.87, y: r * 0.5 }), Canvas.Close()], stroke: colour, lineWidth: w })]
  }
}

const geoMapShapes = (model: EramModel, field: Field, geoMap: GeoMap | null): ReadonlyArray<Canvas.Shape> => {
  if (geoMap === null) {
    return []
  }
  const transform = radarTransform(model)
  const on = new Set(model.filters)
  const shapes: Array<Canvas.Shape> = []
  for (const id of mapsToShow(geoMap, model.tdm)) {
    const map = videoMapById(id)
    if (map === undefined || map.eram === null || !model.loaded.includes(id)) {
      continue
    }
    const defaults = map.eram
    const visible = projected(map, field).filter((p) => eramFeatureVisible(map, p.feature, on))
    if (visible.length === 0) {
      continue
    }
    if (defaults.kind === 'line') {
      const style = defaults.style ?? 'Solid'
      const instructions = visible.flatMap((p) => p.lines.flatMap((flat) => decimatedFlatPath(flat, transform, false)))
      const pattern = DASHES[style]
      shapes.push(
        Canvas.Path({
          instructions: pattern === undefined ? instructions : dashed(instructions, pattern),
          stroke: defaults.size >= 2 ? ERAM.mapBright : ERAM.map,
          lineWidth: Math.min(2, defaults.size * 0.7 + 0.3),
        }),
      )
    } else if (defaults.kind === 'symbol') {
      for (const p of visible) {
        const n = p.points.length / 2
        for (let i = 0; i < n; i++) {
          const x = (p.points[2 * i]! - transform.originX) * transform.scale
          const y = (p.points[2 * i + 1]! - transform.originY) * transform.scale
          if (x < -10 || y < -10 || x > model.width + 10 || y > model.height + 10) {
            continue
          }
          shapes.push(Canvas.Group({ translate: { x, y }, shapes: symbolShapes(p.feature.style ?? defaults.style, defaults.size, ERAM.mapBright) }))
        }
      }
    } else {
      for (const p of visible) {
        const n = p.points.length / 2
        const lines = p.feature.text ?? []
        for (let i = 0; i < n; i++) {
          const x = (p.points[2 * i]! - transform.originX) * transform.scale + defaults.xOffset
          const y = (p.points[2 * i + 1]! - transform.originY) * transform.scale + defaults.yOffset
          if (x < -60 || y < -20 || x > model.width + 60 || y > model.height + 20) {
            continue
          }
          lines.forEach((line, k) => {
            shapes.push(Canvas.Text({ x, y: y + k * LINE_PX, content: line, font: `${Math.min(13, 8 + defaults.size)}px ${MONO}`, fill: ERAM.text, align: 'Center', baseline: 'Middle' }))
          })
        }
      }
    }
  }
  return shapes
}

const staticCanvas = (
  view: EramModel['view'],
  width: number,
  height: number,
  filters: EramModel['filters'],
  tdm: boolean,
  loaded: EramModel['loaded'],
  field: Field | null,
  geoMap: GeoMap | null,
  dpr: number,
): Html => {
  const model: EramModel = { ...({} as EramModel), view, width, height, filters, tdm, loaded, geoMap: geoMap?.id ?? null }
  const shapes: ReadonlyArray<Canvas.Shape> = [
    Canvas.Group({
      scale: { x: dpr, y: dpr },
      shapes: [Canvas.Rect({ x: 0, y: 0, width, height, fill: ERAM.bg }), ...(field === null ? [] : geoMapShapes(model, field, geoMap))],
    }),
  ]
  return Canvas.view({ width: Math.max(1, Math.round(width * dpr)), height: Math.max(1, Math.round(height * dpr)), shapes, className: 'eram-static' }, ih)
}

const lazyStatic = createLazy()

// TARGETS AND DATA BLOCKS

const alt3 = (feet: number): string => String(Math.max(0, Math.round(feet / 100))).padStart(3, '0')

/**
 * Line 2 of an FDB: the assigned altitude with the character that says how the
 * reported altitude relates to it (C level, ↑↓ climbing or descending to it, +−
 * through it, T an interim altitude), then the reported altitude.
 */
export const altitudeLine = (a: Aircraft): string => {
  const current = alt3(a.radar?.altitude ?? a.altitude)
  if (a.interimAltitude !== null) {
    return `${alt3(a.interimAltitude)}T${current}`
  }
  if (a.flightPlan.rules === 'V' && a.assignedAltitude === null) {
    return `VFR/${current}`
  }
  const assigned = a.assignedAltitude
  if (assigned === null) {
    return current
  }
  const altitude = a.radar?.altitude ?? a.altitude
  if (Math.abs(altitude - assigned) < 300) {
    return `${alt3(assigned)}C`
  }
  const climbing = a.targetAltitude > altitude + 100
  const descending = a.targetAltitude < altitude - 100
  const mark = altitude < assigned ? (climbing ? '↑' : '-') : descending ? '↓' : '+'
  return `${alt3(assigned)}${mark}${current}`
}

const EMERGENCY: Readonly<Record<string, string>> = { '7500': 'HIJK', '7600': 'RDOF', '7700': 'EMRG', '1276': 'ADIZ', '7400': 'LLNK', '7777': 'AFIO' }

/** Field E: an emergency code, a handoff in progress (H) or accepted (O), else the ground speed. */
export const fieldE = (world: World, a: Aircraft): string => {
  const emergency = EMERGENCY[a.squawk]
  if (emergency !== undefined) {
    return emergency
  }
  if (a.handoffSector !== null) {
    return `${handoffAccepted(a, world.simTime) ? 'O' : 'H'}${a.handoffSector}`
  }
  return String(Math.round(a.radar?.speed ?? a.speed)).padStart(3, '0')
}

const hsfLine = (a: Aircraft): string | null => {
  const parts = [
    a.hsf.heading === null ? null : `H${String(a.hsf.heading).padStart(3, '0')}`,
    a.hsf.speed === null ? null : `S${a.hsf.speed}`,
    a.hsf.text,
  ].filter((p): p is string => p !== null && p !== '')
  return parts.length === 0 ? null : parts.join(' ')
}

/** The four FDB lines: ACID; assigned/reported altitude; CID and field E; destination or the HSF data. */
export const fdbLines = (world: World, a: Aircraft, block: BlockState): ReadonlyArray<string> => {
  const hsf = block.hsf ? hsfLine(a) : null
  return [a.callsign, altitudeLine(a), `${a.cid} ${fieldE(world, a)}`, hsf ?? a.destination ?? a.type]
}

/** An LDB: the beacon code (or the ACID of an owned track shown small) and the altitude. */
export const ldbLines = (a: Aircraft): ReadonlyArray<string> => [a.tracked ? a.callsign : a.squawk, alt3(a.radar?.altitude ?? a.altitude)]

/** Data block positions as ERAM numbers them, as unit directions (5 is the default, up and to the left). */
const DIRECTIONS: Readonly<Record<number, readonly [number, number]>> = {
  1: [-1, 1], 2: [0, 1], 3: [1, 1], 4: [-1, 0], 5: [-1, -1], 6: [1, 0], 7: [-1, -1], 8: [0, -1], 9: [1, -1],
}

const isFdb = (a: Aircraft, block: BlockState): boolean => block.fdb ?? a.tracked

/** The beacon return: a slash for a transponder reply, a cross for a primary-only target. */
const targetSymbol = (a: Aircraft, colour: string, size: number): Canvas.Shape =>
  a.transponder === 'S'
    ? Canvas.Path({ instructions: [Canvas.MoveTo({ x: -size, y: 0 }), Canvas.LineTo({ x: size, y: 0 }), Canvas.MoveTo({ x: 0, y: -size }), Canvas.LineTo({ x: 0, y: size })], stroke: colour, lineWidth: 1.2 })
    : Canvas.Path({ instructions: [Canvas.MoveTo({ x: -size * 0.7, y: -size }), Canvas.LineTo({ x: size * 0.7, y: size })], stroke: colour, lineWidth: 1.4 })

/** The track's position symbol: a diamond on a flight-plan route, a triangle for a free track (vectors, no fixes). */
const trackSymbol = (a: Aircraft, colour: string, size: number): Canvas.Shape =>
  a.fixes.length > 0 || a.approach !== null
    ? Canvas.Path({ instructions: [Canvas.MoveTo({ x: 0, y: -size }), Canvas.LineTo({ x: size, y: 0 }), Canvas.LineTo({ x: 0, y: size }), Canvas.LineTo({ x: -size, y: 0 }), Canvas.Close()], stroke: colour, lineWidth: 1.3 })
    : Canvas.Path({ instructions: [Canvas.MoveTo({ x: -size, y: 0 }), Canvas.LineTo({ x: size, y: -size * 0.9 }), Canvas.LineTo({ x: size, y: size * 0.9 }), Canvas.Close()], stroke: colour, lineWidth: 1.3 })

/** The VCI: a small green tick in column 0, as CRC draws it. */
const vciShape = (x: number, y: number): Canvas.Shape =>
  Canvas.Path({
    instructions: [Canvas.MoveTo({ x: x - 8, y: y - 7 }), Canvas.LineTo({ x: x - 8, y: y }), Canvas.LineTo({ x: x - 1, y }), Canvas.MoveTo({ x: x - 8, y }), Canvas.LineTo({ x: x - 2, y: y - 6 })],
    stroke: ERAM.vci,
    lineWidth: 1.2,
  })

const routeShapes = (model: EramModel, world: World, callsign: string): ReadonlyArray<Canvas.Shape> => {
  const a = world.aircraft.find((x) => x.callsign === callsign)
  if (a === undefined || a.radar === null) {
    return []
  }
  const start = radarPoint(world, a.radar.position)
  const points = [toCanvas(model, start.x, start.y)]
  const shapes: Array<Canvas.Shape> = []
  for (const name of a.fixes) {
    const c = world.nav.fixes[name]
    if (c === undefined) {
      continue
    }
    const p = radarPoint(world, c)
    const q = toCanvas(model, p.x, p.y)
    points.push(q)
    shapes.push(Canvas.Text({ x: q.x + 4, y: q.y - 3, content: name, font: `10px ${MONO}`, fill: ERAM.route, align: 'Left', baseline: 'Alphabetic' }))
  }
  if (points.length > 1) {
    shapes.push(Canvas.Path({ instructions: points.map((p, i) => (i === 0 ? Canvas.MoveTo({ x: p.x, y: p.y }) : Canvas.LineTo({ x: p.x, y: p.y }))), stroke: ERAM.route, lineWidth: 1 }))
    const end = points[points.length - 1]!
    shapes.push(Canvas.Text({ x: end.x, y: end.y, content: 'X', font: `bold 11px ${MONO}`, fill: ERAM.route, align: 'Center', baseline: 'Middle' }))
  }
  shapes.push(Canvas.Text({ x: points[0]!.x, y: points[0]!.y + 16, content: a.callsign, font: `${FONT_PX}px ${MONO}`, fill: ERAM.route, align: 'Center', baseline: 'Middle' }))
  return shapes
}

const targetShapes = (model: EramModel, world: World, selected: string | null): ReadonlyArray<Canvas.Shape> => {
  const s = pxPerNm(model)
  const shapes: Array<Canvas.Shape> = routesShown(model, world.simTime).flatMap((c) => routeShapes(model, world, c))
  const size = 4.5
  for (const a of world.aircraft) {
    const r = a.radar
    if (r === null) {
      continue
    }
    const block = model.blocks[a.callsign] ?? defaultBlock
    const p = radarPoint(world, r.position)
    const c = toCanvas(model, p.x, p.y)
    if (c.x < -80 || c.y < -60 || c.x > model.width + 80 || c.y > model.height + 60) {
      continue
    }
    const isSelected = a.callsign === selected
    const fdb = isFdb(a, block)
    const ink = isSelected ? ERAM.selected : fdb ? ERAM.fdb : ERAM.ldb
    r.history.forEach((h, i) => {
      const hp = radarPoint(world, h)
      const hc = toCanvas(model, hp.x, hp.y)
      shapes.push(Canvas.Group({ translate: { x: hc.x, y: hc.y }, opacity: 0.25 + 0.12 * i, shapes: [targetSymbol(a, ERAM.history, size * 0.8)] }))
    })
    shapes.push(Canvas.Group({ translate: { x: c.x, y: c.y }, shapes: [targetSymbol(a, isSelected ? ERAM.selected : ERAM.target, size)] }))
    if (a.tracked) {
      shapes.push(Canvas.Group({ translate: { x: c.x, y: c.y }, shapes: [trackSymbol(a, ink, size)] }))
    }
    if (block.halo) {
      shapes.push(Canvas.Circle({ x: c.x, y: c.y, radius: HALO_NM * s, stroke: ERAM.halo, lineWidth: 1 }))
    }
    if (model.vector > 0 && a.state === 'AIRB') {
      const nm = (r.speed / 60) * model.vector
      const rad = (a.heading * Math.PI) / 180
      const end = toCanvas(model, p.x + Math.sin(rad) * nm, p.y - Math.cos(rad) * nm)
      shapes.push(Canvas.Group({ opacity: 0.8, shapes: [Canvas.Path({ instructions: [Canvas.MoveTo({ x: c.x, y: c.y }), Canvas.LineTo({ x: end.x, y: end.y })], stroke: ink, lineWidth: 1 })] }))
    }
    if (!fdb) {
      const lines = ldbLines(a)
      const right = block.position === 1 || block.position === 4 || block.position === 7
      lines.forEach((text, i) => {
        shapes.push(Canvas.Text({ x: right ? c.x - size - 4 : c.x + size + 4, y: c.y - 2 + i * LINE_PX, content: text, font: `${FONT_PX}px ${MONO}`, fill: ink, align: right ? 'Right' : 'Left', baseline: 'Middle' }))
      })
      continue
    }
    const [dx, dy] = DIRECTIONS[block.position] ?? DIRECTIONS[5]!
    const leaderPx = LEADER_PX[block.leader ?? model.leader] ?? LEADER_PX[1]!
    const norm = Math.hypot(dx, dy) || 1
    const lx = c.x + (dx / norm) * (size + leaderPx)
    const ly = c.y + (dy / norm) * (size + leaderPx)
    shapes.push(Canvas.Path({ instructions: [Canvas.MoveTo({ x: c.x + (dx / norm) * size, y: c.y + (dy / norm) * size }), Canvas.LineTo({ x: lx, y: ly })], stroke: ink, lineWidth: 1 }))
    const lines = fdbLines(world, a, block)
    const align: Canvas.TextAlign = dx < 0 ? 'Right' : dx > 0 ? 'Left' : 'Center'
    const top = dy < 0 ? ly - lines.length * LINE_PX + 4 : dy > 0 ? ly + 4 : ly - (lines.length * LINE_PX) / 2 + 6
    const textX = dx < 0 ? lx - 2 : dx > 0 ? lx + 2 : lx
    lines.forEach((text, i) => {
      shapes.push(
        Canvas.Text({
          x: textX,
          y: top + i * LINE_PX + LINE_PX / 2,
          content: text,
          font: `${FONT_PX}px ${MONO}`,
          fill: i === 3 && !isSelected ? ERAM.fdbDim : ink,
          align,
          baseline: 'Middle',
        }),
      )
    })
    const vci = block.vci ?? a.checkedIn
    const leftEdge = dx < 0 ? textX - FONT_PX * 0.62 * Math.max(...lines.map((l) => l.length)) : dx > 0 ? textX : textX - (FONT_PX * 0.62 * Math.max(...lines.map((l) => l.length))) / 2
    if (vci) {
      shapes.push(vciShape(leftEdge - 2, top + LINE_PX * 1.5 + 3))
    }
    if (!a.tracked) {
      shapes.push(Canvas.Text({ x: leftEdge - 6, y: top + LINE_PX * 2.5, content: 'R', font: `${FONT_PX}px ${MONO}`, fill: ERAM.vci, align: 'Right', baseline: 'Middle' }))
    }
  }
  return shapes
}

const radarCanvas = (model: EramModel, inputs: EramInputs, h: HtmlBuilder<EramMessage>): Html => {
  const dpr = inputs.devicePixelRatio
  const world = inputs.world
  const shapes: ReadonlyArray<Canvas.Shape> = [Canvas.Group({ scale: { x: dpr, y: dpr }, shapes: world === null ? [] : targetShapes(model, world, inputs.selected) })]
  return Canvas.view(
    {
      width: Math.max(1, Math.round(model.width * dpr)),
      height: Math.max(1, Math.round(model.height * dpr)),
      shapes,
      className: 'eram-canvas',
      onPointerDown: ({ x, y }) => EramMessage.Pressed({ x: x / dpr, y: y / dpr }),
      ...(model.drag === null ? {} : { onPointerMove: ({ x, y }: Canvas.Point) => EramMessage.Moved({ x: x / dpr, y: y / dpr }) }),
      onPointerUp: ({ x, y }) => EramMessage.Released({ x: x / dpr, y: y / dpr }),
    },
    h,
  )
}

// CHROME

const twoLine = (h: HtmlBuilder<EramMessage>, label: readonly [string, string]): ReadonlyArray<Html | string> => [label[0], h.br([]), label[1]]

const toolbar = (model: EramModel, artcc: ArtccFile | null, geoMap: GeoMap | null, h: HtmlBuilder<EramMessage>): Html => {
  const loading = geoMap === null ? 0 : mapsToShow(geoMap, model.tdm).filter((id) => !model.loaded.includes(id) && !model.failed.includes(id)).length
  return h.div(
    [h.Class('etb')],
    [
      h.button(
        [h.Type('button'), h.Class(`etb-map${model.menuOpen ? ' open' : ''}`), h.Title('GeoMap (MR)'), h.OnClick(EramMessage.ClickedMenu())],
        geoMap === null ? ['NO', h.br([]), 'GEOMAP'] : twoLine(h, geoMap.label),
      ),
      ...(geoMap === null
        ? []
        : geoMap.filters.flatMap((label, i) =>
            label[0] === '' && label[1] === ''
              ? []
              : [
                  h.button(
                    [h.Type('button'), h.Class('etb-filter'), h.AriaPressed(model.filters.includes(i + 1) ? 'true' : 'false'), h.Title(`Filter ${i + 1}`), h.OnClick(EramMessage.ToggledFilter({ index: i + 1 }))],
                    twoLine(h, label),
                  ),
                ],
          )),
      h.span([h.Class('etb-gap')], []),
      h.button([h.Type('button'), h.Class('etb-filter'), h.AriaPressed(model.tdm ? 'true' : 'false'), h.Title('Top-Down mode: airport diagrams (large)'), h.OnClick(EramMessage.ToggledTdm())], ['TDM']),
      h.button([h.Type('button'), h.Class('etb-filter'), h.Title('Velocity vector length, minutes'), h.OnClick(EramMessage.ClickedVector())], ['VECTOR', h.br([]), String(model.vector)]),
      h.button([h.Type('button'), h.Class('etb-filter'), h.Title('Default leader length'), h.OnClick(EramMessage.ClickedLeader())], ['FDB LDR', h.br([]), String(model.leader)]),
      h.button([h.Type('button'), h.Class('etb-filter'), h.AriaLabel('Range down'), h.OnClick(EramMessage.ClickedRangeIn())], ['RANGE', h.br([]), '−']),
      h.button([h.Type('button'), h.Class('etb-filter'), h.AriaLabel('Range up'), h.OnClick(EramMessage.ClickedRangeOut())], ['RANGE', h.br([]), '+']),
      h.button([h.Type('button'), h.Class('etb-filter'), h.AriaLabel('Recentre'), h.OnClick(EramMessage.ClickedCentre())], ['CNTR']),
      loading > 0 ? h.span([h.Class('etb-note')], [`loading ${loading}`]) : h.empty,
      artcc === null ? h.span([h.Class('etb-note')], ['no ERAM data for this ARTCC']) : h.empty,
    ],
  )
}

const geoMapMenu = (model: EramModel, artcc: ArtccFile | null, h: HtmlBuilder<EramMessage>): Html =>
  h.div(
    [h.Class('egm')],
    artcc === null || artcc.geoMaps.length === 0
      ? [h.div([h.Class('grp')], ['no GeoMaps'])]
      : [
          h.div([h.Class('grp')], [`${artcc.id} GeoMaps`]),
          ...artcc.geoMaps.map((g) =>
            h.button([h.Type('button'), h.AriaPressed(g.id === model.geoMap ? 'true' : 'false'), h.OnClick(EramMessage.PickedGeoMap({ id: g.id }))], [h.b([], [g.label.join(' ')]), ` ${g.name} · ${g.maps.length} elements`]),
          ),
        ],
  )

const timeView = (simTime: number): string => {
  const t = Math.floor(simTime)
  return `${String(Math.floor(t / 3600) % 24).padStart(2, '0')}${String(Math.floor(t / 60) % 60).padStart(2, '0')} ${String(t % 60).padStart(2, '0')}`
}

export const eramView = Submodel.defineView<EramModel, EramMessage, EramInputs>((model, inputs, h) => {
  const world = inputs.world
  const artcc = inputs.artcc
  const geoMap = geoMapById(artcc, model.geoMap)
  const targets = world === null ? 0 : world.aircraft.filter((a) => a.radar !== null).length
  const hud = `${artcc !== null ? `${artcc.nasId} ERAM · ${artcc.name}` : 'ERAM'} · ${(model.view.w / 2).toFixed(0)} nm · targets ${targets}`
  return h.div(
    [h.Class('eram'), h.OnMount(StarsSurface())],
    [
      lazyStatic(staticCanvas, [model.view, model.width, model.height, model.filters, model.tdm, model.loaded, world === null ? null : fieldOf(world), geoMap, inputs.devicePixelRatio]),
      radarCanvas(model, inputs, h),
      toolbar(model, artcc, geoMap, h),
      model.menuOpen ? geoMapMenu(model, artcc, h) : h.empty,
      h.div([h.Class('etime')], [timeView(world?.simTime ?? 0)]),
      h.div(
        [h.Class('emca')],
        [
          model.feedback === null
            ? h.div([h.Class('efb')], ['_'])
            : h.div([h.Class(`efb ${model.feedback.ok ? 'ok' : 'bad'}`)], [model.feedback.ok ? '✓ ' : '✗ ', model.feedback.text]),
          ...(model.response.length === 0 ? [] : [h.div([h.Class('era')], [...model.response.map((line) => h.div([], [line])), h.button([h.Type('button'), h.Title('Clear the Response Area'), h.OnClick(EramMessage.ClickedClearResponse())], ['CLEAR'])])]),
        ],
      ),
      h.div([h.Class('scope-hud ehud')], [hud]),
    ],
  )
})
