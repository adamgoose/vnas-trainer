/**
 * The radial command menu over the ground scope or the STARS pane: a pie of SVG
 * wedges around the clicked aircraft (src/app/radial.ts decides the wedges),
 * kept inside the pane that opened it. The hole in the middle goes back a ring,
 * or closes at the root; a wedge with an outer mark opens another ring. Labels
 * are the command mnemonics only.
 */
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Message } from '../app/message'
import { type Model, type RadialPane, worldOf } from '../app/model'
import { planPreview } from '../app/plan'
import { offersRunways, radialAt } from '../app/radial'
import type { Aircraft } from '../domain/aircraft'
import type { World } from '../domain/world'
import { radarPoint, toCanvas as toRadar } from '../positions/local/stars'
import { toCanvas, toWorld } from './viewport'

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** Radius of the hole around the target. */
export const INNER_RADIUS = 22
/** Outer radius for `n` wedges: wider rings get longer wedges for their labels. */
export const outerRadius = (n: number): number => (n <= 6 ? 66 : n <= 9 ? 76 : 88)

type Point = Readonly<{ x: number; y: number }>
const polar = (r: number, a: number): Point => ({ x: r * Math.cos(a), y: r * Math.sin(a) })
const pt = (p: Point): string => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`

/** The annular sector from angle a0 to a1 (radians, clockwise on screen). */
export const wedgePath = (r0: number, r1: number, a0: number, a1: number): string => {
  if (a1 - a0 >= 2 * Math.PI - 1e-9) {
    const mid = a0 + Math.PI
    return `M${pt(polar(r1, a0))} A${r1} ${r1} 0 1 1 ${pt(polar(r1, mid))} A${r1} ${r1} 0 1 1 ${pt(polar(r1, a0))} M${pt(polar(r0, a0))} A${r0} ${r0} 0 1 0 ${pt(polar(r0, mid))} A${r0} ${r0} 0 1 0 ${pt(polar(r0, a0))} Z`
  }
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M${pt(polar(r1, a0))} A${r1} ${r1} 0 ${large} 1 ${pt(polar(r1, a1))} L${pt(polar(r0, a1))} A${r0} ${r0} 0 ${large} 0 ${pt(polar(r0, a0))} Z`
}

/** A thin arc just outside the wedge, marking an entry that opens another ring. */
const markPath = (r: number, a0: number, a1: number): string => {
  const inset = 0.06
  const large = a1 - a0 - 2 * inset > Math.PI ? 1 : 0
  return `M${pt(polar(r, a0 + inset))} A${r} ${r} 0 ${large} 1 ${pt(polar(r, a1 - inset))}`
}

type Anchor = Readonly<{ x: number; y: number; width: number; height: number }>

/** Where the ring centres in `pane`: the aircraft on the ground scope, or its radar return on the STARS pane. */
const anchorOf = (model: Model, world: World, pane: RadialPane, aircraft: Aircraft): Anchor => {
  if (pane === 'stars') {
    const p = radarPoint(world, aircraft.radar?.position ?? aircraft.position)
    return { ...toRadar(model.stars, p.x, p.y), width: model.stars.width, height: model.stars.height }
  }
  return { ...toCanvas(model.scope, toWorld(world.graph, aircraft.position)), width: model.scope.width, height: model.scope.height }
}

/** The ring, when `pane` is the one that opened it. */
export const radialView = (model: Model, h: HtmlBuilder<Message>, pane: RadialPane): Html => {
  const world = worldOf(model)
  const radial = model.radial
  if (world === null || radial === null || radial.pane !== pane || model.selected !== radial.callsign) {
    return h.empty
  }
  const aircraft = world.aircraft.find((a) => a.callsign === radial.callsign)
  if (aircraft === undefined || aircraft.delay > 0) {
    return h.empty
  }
  const node = radialAt(world, model.settings.mode, aircraft, radial.trail)
  if (node === null || (node._tag !== 'Menu' && node._tag !== 'Plan')) {
    return h.empty
  }
  const error = node._tag === 'Plan' ? planPreview(world, aircraft, node.plan).error : null
  const n = node.items.length
  const r0 = INNER_RADIUS
  const r1 = outerRadius(n)
  const extent = r1 + 8
  const margin = extent + 28
  const at = anchorOf(model, world, pane, aircraft)
  const cx = clamp(at.x, margin, Math.max(margin, at.width - margin))
  const cy = clamp(at.y, margin, Math.max(margin, at.height - margin))
  const root = radial.trail.length === 0
  const step = (2 * Math.PI) / n
  const rotated = n > 8
  return h.div(
    [
      h.Class('radial'),
      h.Style({ left: `${cx.toFixed(1)}px`, top: `${cy.toFixed(1)}px` }),
      // the STARS ring sits beside the pane, outside its right-click listener: a right-click on it closes it and skips the browser's menu, as on empty radar
      ...(pane === 'stars' ? [h.OnContextMenu(Message.ClosedRadial())] : []),
    ],
    [
      h.svg(
        [
          h.ViewBox(`${-extent} ${-extent} ${2 * extent} ${2 * extent}`),
          h.Attribute('width', String(2 * extent)),
          h.Attribute('height', String(2 * extent)),
          h.Style({ left: `${-extent}px`, top: `${-extent}px` }),
        ],
        [
          ...node.items.map((item, i) => {
            const a0 = -Math.PI / 2 - step / 2 + i * step
            const a1 = a0 + step
            const mid = a0 + step / 2
            const label = polar((r0 + r1) / 2 + (rotated ? 2 : 0), mid)
            const degrees = (mid * 180) / Math.PI
            const flip = Math.cos(mid) < -1e-9
            return h.g(
              [h.Class('radial-wedge'), h.OnClick(Message.PickedRadial({ key: item.key }), { propagation: 'Stop' })],
              [
                h.path([h.D(wedgePath(r0, r1, a0, a1))]),
                ...(item.opens ? [h.path([h.Class('mark'), h.D(markPath(r1 + 4, a0, a1))])] : []),
                h.text(
                  [
                    h.X(label.x.toFixed(2)),
                    h.Y(label.y.toFixed(2)),
                    h.TextAnchor('middle'),
                    h.DominantBaseline('central'),
                    ...(rotated ? [h.Transform(`rotate(${(flip ? degrees + 180 : degrees).toFixed(1)} ${label.x.toFixed(2)} ${label.y.toFixed(2)})`)] : []),
                  ],
                  [item.label],
                ),
              ],
            )
          }),
          h.circle([h.Class('radial-hole'), h.Cx('0'), h.Cy('0'), h.R(String(r0 - 2)), h.OnClick(Message.ClickedRadialBack(), { propagation: 'Stop' })], []),
        ],
      ),
      root ? h.empty : h.div([h.Class(`radial-title${error !== null ? ' err' : ''}`), h.Style({ top: `${extent + 4}px` })], [error !== null ? `${node.title} — ${error}` : node.title]),
    ],
  )
}

/**
 * While the ring offers runways, a button on every runway number picks that end
 * for the selected aircraft: the same pick as the ring's wedge, without the hunt.
 */
export const runwayButtonsView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const world = worldOf(model)
  const radial = model.radial
  if (world === null || radial === null || radial.pane !== 'asdex' || model.selected !== radial.callsign) {
    return []
  }
  const aircraft = world.aircraft.find((a) => a.callsign === radial.callsign)
  if (aircraft === undefined || aircraft.delay > 0) {
    return []
  }
  const node = radialAt(world, model.settings.mode, aircraft, radial.trail)
  if (node === null || !offersRunways(node)) {
    return []
  }
  const graph = world.graph
  return Object.entries(graph.runwayEnds).flatMap(([designator, end]) => {
    const at = toCanvas(model.scope, toWorld(graph, graph.nodes[end.chain[0]!]!))
    if (at.x < 0 || at.y < 0 || at.x > model.scope.width || at.y > model.scope.height) {
      return []
    }
    return [
      h.button(
        [
          h.Type('button'),
          h.Class('rwy-btn'),
          h.Style({ left: `${at.x.toFixed(1)}px`, top: `${at.y.toFixed(1)}px` }),
          h.Title(`runway ${designator}`),
          h.OnClick(Message.PickedRunwayButton({ designator }), { propagation: 'Stop' }),
        ],
        [designator],
      ),
    ]
  })
}
