/**
 * The window layout, i3 style: every display is a *panel* that is either tiled
 * in a tree of splits, floating over the tiles, or closed. One layout per
 * position (a position is a workspace). Pure tree operations; the view draws
 * the tree with flexbox and the update applies these on pointer messages.
 */
import { Schema } from 'effect'

import { type PositionMode, positionFor } from '../positions'

export const Panel = Schema.Literals(['controls', 'asdex', 'stars', 'strips', 'console', 'rewind', 'commands', 'settings', 'session'])
export type Panel = typeof Panel.Type
export const PANELS: ReadonlyArray<Panel> = Panel.literals

export const Edge = Schema.Literals(['left', 'right', 'top', 'bottom', 'center'])
export type Edge = typeof Edge.Type

export const Dir = Schema.Literals(['row', 'col'])
export type Dir = typeof Dir.Type

/** the handles a floating window can be resized by */
export const Grip = Schema.Literals(['right', 'bottom', 'corner'])
export type Grip = typeof Grip.Type

export interface Leaf {
  readonly _tag: 'Leaf'
  readonly panel: Panel
}
export interface Split {
  readonly _tag: 'Split'
  readonly dir: Dir
  readonly children: ReadonlyArray<Node>
  /** one fraction per child, summing to 1 */
  readonly sizes: ReadonlyArray<number>
}
export type Node = Leaf | Split

export const Leaf = Schema.Struct({ _tag: Schema.Literal('Leaf'), panel: Panel })
export const Split = Schema.Struct({
  _tag: Schema.Literal('Split'),
  dir: Dir,
  children: Schema.Array(Schema.suspend((): Schema.Codec<Node> => Node)),
  sizes: Schema.Array(Schema.Number),
})
export const Node: Schema.Codec<Node> = Schema.Union([Leaf, Split])

export const Rect = Schema.Struct({ x: Schema.Number, y: Schema.Number, w: Schema.Number, h: Schema.Number })
export type Rect = typeof Rect.Type

export const Floating = Schema.Struct({ panel: Panel, x: Schema.Number, y: Schema.Number, w: Schema.Number, h: Schema.Number })
export type Floating = typeof Floating.Type

export const Layout = Schema.Struct({
  root: Schema.NullOr(Node),
  /** bottom to top */
  floating: Schema.Array(Floating),
  /** where each panel last floated, so tiling and floating again keeps its place */
  rects: Schema.Record(Schema.String, Rect),
})
export type Layout = typeof Layout.Type

export const Layouts = Schema.Struct({ ground: Layout, tower: Layout, tracon: Layout })
export type Layouts = typeof Layouts.Type

export const Size = Schema.Struct({ width: Schema.Number, height: Schema.Number })
export type Size = typeof Size.Type

/** the smallest share of a split a child keeps while a gutter is dragged */
export const MIN_SHARE = 0.06
export const MIN_FLOAT_W = 240
export const MIN_FLOAT_H = 120
/** how much of a floating window must stay inside the workspace */
export const KEEP_VISIBLE_PX = 120
export const TITLE_PX = 26
/** the share of the height the Controls window opens with */
export const CONTROLS_SHARE = 0.1

// PANELS

export type PanelSpec = Readonly<{
  title: string
  /** opens floating and is closed again when the app loads */
  transient: boolean
  /** the size it floats at */
  size: Readonly<{ w: number; h: number }>
  /** where it docks when opened tiled: the first panel present wins, else `rootEdge` */
  dock: ReadonlyArray<Readonly<{ beside: Panel; edge: Edge }>>
  rootEdge: Edge
}>

export const PANEL_SPECS: Readonly<Record<Panel, PanelSpec>> = {
  controls: { title: 'Controls', transient: false, size: { w: 900, h: 64 }, dock: [], rootEdge: 'top' },
  asdex: { title: 'ASDE-X', transient: false, size: { w: 720, h: 520 }, dock: [{ beside: 'stars', edge: 'left' }, { beside: 'strips', edge: 'left' }], rootEdge: 'left' },
  stars: { title: 'STARS', transient: false, size: { w: 720, h: 520 }, dock: [{ beside: 'asdex', edge: 'right' }, { beside: 'strips', edge: 'left' }], rootEdge: 'right' },
  strips: { title: 'Strips', transient: false, size: { w: 320, h: 520 }, dock: [{ beside: 'stars', edge: 'right' }, { beside: 'asdex', edge: 'right' }], rootEdge: 'right' },
  console: { title: 'Console', transient: false, size: { w: 760, h: 240 }, dock: [], rootEdge: 'bottom' },
  rewind: { title: 'Rewind', transient: false, size: { w: 760, h: 220 }, dock: [{ beside: 'console', edge: 'top' }], rootEdge: 'bottom' },
  commands: { title: 'Command reference', transient: true, size: { w: 760, h: 620 }, dock: [], rootEdge: 'right' },
  settings: { title: 'Settings', transient: true, size: { w: 760, h: 620 }, dock: [], rootEdge: 'right' },
  session: { title: 'Shared session', transient: true, size: { w: 540, h: 460 }, dock: [], rootEdge: 'right' },
}

/** The panels a position has: the ground scope needs a ground scope, the radar a radar. */
export const availablePanels = (mode: PositionMode): ReadonlyArray<Panel> => {
  const position = positionFor(mode)
  return PANELS.filter((p) => (p === 'asdex' ? position.groundScope : p === 'stars' ? position.hasRadar : true))
}

// TREE

const leaf = (panel: Panel): Leaf => ({ _tag: 'Leaf', panel })
const split = (dir: Dir, children: ReadonlyArray<Node>, sizes: ReadonlyArray<number>): Split => ({ _tag: 'Split', dir, children, sizes })

const dirOf = (edge: Edge): Dir => (edge === 'left' || edge === 'right' ? 'row' : 'col')
const before = (edge: Edge): boolean => edge === 'left' || edge === 'top'

/** Sizes as a distribution: length matched to the children, non-finite or negative entries evened out, sum 1. */
export const normaliseSizes = (sizes: ReadonlyArray<number>, n: number): ReadonlyArray<number> => {
  if (n === 0) {
    return []
  }
  const raw = Array.from({ length: n }, (_, i) => {
    const s = sizes[i]
    return s !== undefined && Number.isFinite(s) && s > 0 ? s : 1 / n
  })
  const total = raw.reduce((a, b) => a + b, 0)
  return raw.map((s) => s / total)
}

/** A well-formed tree: single-child splits collapse, empty ones vanish, sizes are a distribution. */
export const normalise = (node: Node | null): Node | null => {
  if (node === null || node._tag === 'Leaf') {
    return node
  }
  const children = node.children.map((c, i) => [normalise(c), node.sizes[i] ?? 0] as const).filter((x): x is readonly [Node, number] => x[0] !== null)
  if (children.length === 0) {
    return null
  }
  if (children.length === 1) {
    return children[0]![0]
  }
  return split(
    node.dir,
    children.map((c) => c[0]),
    normaliseSizes(
      children.map((c) => c[1]),
      children.length,
    ),
  )
}

export const panelsOf = (node: Node | null): ReadonlyArray<Panel> =>
  node === null ? [] : node._tag === 'Leaf' ? [node.panel] : node.children.flatMap(panelsOf)

export const contains = (node: Node | null, panel: Panel): boolean => panelsOf(node).includes(panel)

export const remove = (node: Node | null, panel: Panel): Node | null => {
  if (node === null) {
    return null
  }
  if (node._tag === 'Leaf') {
    return node.panel === panel ? null : node
  }
  const kept = node.children.map((c, i) => [remove(c, panel), node.sizes[i] ?? 0] as const).filter((x): x is readonly [Node, number] => x[0] !== null)
  return normalise(
    split(
      node.dir,
      kept.map((k) => k[0]),
      kept.map((k) => k[1]),
    ),
  )
}

/**
 * Put `panel` next to `target` on the given side. When the target's parent already
 * runs that way the new leaf joins it, taking half the target's share; otherwise
 * the target leaf becomes a two-way split, as i3 does.
 */
export const insertBeside = (node: Node | null, target: Panel, panel: Panel, edge: Edge): Node | null => {
  if (node === null) {
    return leaf(panel)
  }
  if (edge === 'center') {
    return node
  }
  const dir = dirOf(edge)
  const wrap = (t: Node): Split => (before(edge) ? split(dir, [leaf(panel), t], [0.5, 0.5]) : split(dir, [t, leaf(panel)], [0.5, 0.5]))
  const go = (n: Node): Node => {
    if (n._tag === 'Leaf') {
      return n.panel === target ? wrap(n) : n
    }
    const i = n.children.findIndex((c) => c._tag === 'Leaf' && c.panel === target)
    if (i >= 0 && n.dir === dir) {
      const share = (n.sizes[i] ?? 1 / n.children.length) / 2
      const children = [...n.children]
      const sizes = [...n.sizes]
      sizes[i] = share
      children.splice(before(edge) ? i : i + 1, 0, leaf(panel))
      sizes.splice(before(edge) ? i : i + 1, 0, share)
      return split(n.dir, children, sizes)
    }
    return split(n.dir, n.children.map(go), n.sizes)
  }
  return normalise(go(node))
}

export const swap = (node: Node | null, a: Panel, b: Panel): Node | null => {
  const go = (n: Node): Node => (n._tag === 'Leaf' ? (n.panel === a ? leaf(b) : n.panel === b ? leaf(a) : n) : split(n.dir, n.children.map(go), n.sizes))
  return node === null ? null : go(node)
}

/** Add `panel` at the root's edge: alongside the root split when it runs that way, else wrapping it. */
export const insertAtRoot = (node: Node | null, panel: Panel, edge: Edge, share = 0.25): Node | null => {
  if (node === null) {
    return leaf(panel)
  }
  const dir = dirOf(edge)
  if (node._tag === 'Split' && node.dir === dir) {
    const rest = node.sizes.map((s) => s * (1 - share))
    return before(edge) ? split(dir, [leaf(panel), ...node.children], [share, ...rest]) : split(dir, [...node.children, leaf(panel)], [...rest, share])
  }
  return before(edge) ? split(dir, [leaf(panel), node], [share, 1 - share]) : split(dir, [node, leaf(panel)], [1 - share, share])
}

/** The split at `path` (child indices from the root), or null. */
export const splitAt = (node: Node | null, path: ReadonlyArray<number>): Split | null => {
  let current: Node | null = node
  for (const i of path) {
    if (current === null || current._tag !== 'Split') {
      return null
    }
    current = current.children[i] ?? null
  }
  return current !== null && current._tag === 'Split' ? current : null
}

/**
 * Drag the gutter after child `index` of the split at `path` to `fraction` of the
 * split's length: the two neighbours trade share, each keeping at least MIN_SHARE.
 */
export const resizeAt = (node: Node | null, path: ReadonlyArray<number>, index: number, fraction: number): Node | null => {
  const go = (n: Node, depth: number): Node => {
    if (n._tag === 'Leaf') {
      return n
    }
    if (depth < path.length) {
      const i = path[depth]!
      return split(n.dir, n.children.map((c, j) => (j === i ? go(c, depth + 1) : c)), n.sizes)
    }
    if (index < 0 || index >= n.children.length - 1) {
      return n
    }
    const sizes = [...normaliseSizes(n.sizes, n.children.length)]
    const start = sizes.slice(0, index).reduce((a, b) => a + b, 0)
    const pair = sizes[index]! + sizes[index + 1]!
    const first = Math.min(pair - MIN_SHARE, Math.max(MIN_SHARE, fraction - start))
    sizes[index] = first
    sizes[index + 1] = pair - first
    return split(n.dir, n.children, sizes)
  }
  return node === null ? null : go(node, 0)
}

/** Every leaf with the path of its parent split and its index there (the root leaf has no parent). */
export const leaves = (node: Node | null): ReadonlyArray<Readonly<{ panel: Panel; path: ReadonlyArray<number> }>> => {
  const out: Array<{ panel: Panel; path: ReadonlyArray<number> }> = []
  const go = (n: Node, path: ReadonlyArray<number>) => {
    if (n._tag === 'Leaf') {
      out.push({ panel: n.panel, path })
    } else {
      n.children.forEach((c, i) => go(c, [...path, i]))
    }
  }
  if (node !== null) {
    go(node, [])
  }
  return out
}

// LAYOUT

export const emptyLayout: Layout = { root: null, floating: [], rects: {} }

export type Placement = 'tiled' | 'floating' | null

export const placement = (layout: Layout, panel: Panel): Placement =>
  contains(layout.root, panel) ? 'tiled' : layout.floating.some((f) => f.panel === panel) ? 'floating' : null

export const isOpen = (layout: Layout, panel: Panel): boolean => placement(layout, panel) !== null

const clampRect = (rect: Rect, ws: Size): Rect => {
  const w = Math.max(MIN_FLOAT_W, ws.width > 0 ? Math.min(rect.w, ws.width) : rect.w)
  const h = Math.max(MIN_FLOAT_H, ws.height > 0 ? Math.min(rect.h, ws.height) : rect.h)
  const x = ws.width > 0 ? Math.max(KEEP_VISIBLE_PX - w, Math.min(ws.width - KEEP_VISIBLE_PX, rect.x)) : Math.max(0, rect.x)
  const y = ws.height > 0 ? Math.max(0, Math.min(ws.height - TITLE_PX, rect.y)) : Math.max(0, rect.y)
  return { x, y, w, h }
}

/** Where a panel floats: where it last floated, else centred with a small cascade per window already up. */
const floatRect = (layout: Layout, panel: Panel, ws: Size): Rect => {
  const remembered = layout.rects[panel]
  if (remembered !== undefined) {
    return clampRect(remembered, ws)
  }
  const size = PANEL_SPECS[panel].size
  const w = ws.width > 0 ? Math.min(size.w, ws.width - 24) : size.w
  const h = ws.height > 0 ? Math.min(size.h, ws.height - 24) : size.h
  const step = 24 * layout.floating.length
  const x = ws.width > 0 ? Math.max(12, (ws.width - w) / 2) + step : 40 + step
  const y = ws.height > 0 ? Math.max(12, (ws.height - h) / 2) + step : 40 + step
  return clampRect({ x, y, w, h }, ws)
}

export const close = (layout: Layout, panel: Panel): Layout => {
  const floating = layout.floating.find((f) => f.panel === panel)
  return {
    root: remove(layout.root, panel),
    floating: layout.floating.filter((f) => f.panel !== panel),
    rects: floating === undefined ? layout.rects : { ...layout.rects, [panel]: { x: floating.x, y: floating.y, w: floating.w, h: floating.h } },
  }
}

export const openFloating = (layout: Layout, panel: Panel, ws: Size): Layout => {
  const closed = close(layout, panel)
  const rect = floatRect(closed, panel, ws)
  return { ...closed, floating: [...closed.floating, { panel, ...rect }] }
}

/** Open tiled where the panel's spec says: beside the first docking partner present, else at the root's edge. */
export const openTiled = (layout: Layout, panel: Panel): Layout => {
  const closed = close(layout, panel)
  const spec = PANEL_SPECS[panel]
  const partner = spec.dock.find((d) => contains(closed.root, d.beside))
  const root = partner !== undefined ? insertBeside(closed.root, partner.beside, panel, partner.edge) : insertAtRoot(closed.root, panel, spec.rootEdge, panel === 'controls' ? CONTROLS_SHARE : 0.25)
  return { ...closed, root }
}

export const open = (layout: Layout, panel: Panel, ws: Size): Layout =>
  isOpen(layout, panel) ? layout : PANEL_SPECS[panel].transient ? openFloating(layout, panel, ws) : openTiled(layout, panel)

export const toggle = (layout: Layout, panel: Panel, ws: Size): Layout => (isOpen(layout, panel) ? close(layout, panel) : open(layout, panel, ws))

/** Tiled becomes floating and back. */
export const toggleFloat = (layout: Layout, panel: Panel, ws: Size): Layout =>
  placement(layout, panel) === 'floating' ? openTiled(layout, panel) : openFloating(layout, panel, ws)

/** Drop `panel` on `target`'s side: the centre swaps two tiles, or docks a floating window to the right. */
export const dock = (layout: Layout, panel: Panel, target: Panel, edge: Edge): Layout => {
  if (panel === target || !contains(layout.root, target)) {
    return layout
  }
  if (edge === 'center') {
    return placement(layout, panel) === 'tiled' ? { ...layout, root: swap(layout.root, panel, target) } : dock(layout, panel, target, 'right')
  }
  const closed = close(layout, panel)
  return { ...closed, root: insertBeside(closed.root, target, panel, edge) }
}

export const raise = (layout: Layout, panel: Panel): Layout => {
  const f = layout.floating.find((x) => x.panel === panel)
  return f === undefined || layout.floating[layout.floating.length - 1] === f ? layout : { ...layout, floating: [...layout.floating.filter((x) => x !== f), f] }
}

const withFloating = (layout: Layout, panel: Panel, f: (w: Floating) => Floating): Layout => ({
  ...layout,
  floating: layout.floating.map((w) => (w.panel === panel ? f(w) : w)),
})

export const moveFloating = (layout: Layout, panel: Panel, x: number, y: number, ws: Size): Layout =>
  withFloating(layout, panel, (w) => ({ ...w, ...clampRect({ x, y, w: w.w, h: w.h }, ws) }))

/** Pull a grip to the pointer at (x, y) in workspace px. */
export const resizeFloating = (layout: Layout, panel: Panel, grip: Grip, x: number, y: number): Layout =>
  withFloating(layout, panel, (w) => ({
    ...w,
    w: grip === 'bottom' ? w.w : Math.max(MIN_FLOAT_W, Math.round(x - w.x)),
    h: grip === 'right' ? w.h : Math.max(MIN_FLOAT_H, Math.round(y - w.y)),
  }))

export const resizeGutter = (layout: Layout, path: ReadonlyArray<number>, index: number, fraction: number): Layout => ({
  ...layout,
  root: resizeAt(layout.root, path, index, fraction),
})

/** The layout without the panels the position lacks. */
export const prune = (layout: Layout, available: ReadonlyArray<Panel>): Layout =>
  PANELS.filter((p) => !available.includes(p)).reduce((l, p) => (isOpen(l, p) ? close(l, p) : l), layout)

/** Floating windows kept on screen after the workspace changed size. */
export const fitFloating = (layout: Layout, ws: Size): Layout =>
  ws.width <= 0 || ws.height <= 0 ? layout : { ...layout, floating: layout.floating.map((w) => ({ ...w, ...clampRect(w, ws) })) }

// DEFAULTS

const columns = (middle: ReadonlyArray<readonly [Panel, number]>): Node =>
  split('col', [leaf('controls'), split('row', middle.map(([p]) => leaf(p)), middle.map(([, s]) => s)), leaf('console')], [CONTROLS_SHARE, 1 - CONTROLS_SHARE - 0.28, 0.28])

export const defaultLayouts: Layouts = {
  ground: { root: columns([['asdex', 0.78], ['strips', 0.22]]), floating: [], rects: {} },
  tower: { root: columns([['asdex', 0.4], ['stars', 0.4], ['strips', 0.2]]), floating: [], rects: {} },
  tracon: { root: columns([['stars', 0.78], ['strips', 0.22]]), floating: [], rects: {} },
}

/** What comes back from storage: trees repaired, and the transient windows closed. */
export const loadedLayout = (layout: Layout): Layout =>
  PANELS.filter((p) => PANEL_SPECS[p].transient).reduce((l, p) => close(l, p), { ...layout, root: normalise(layout.root) })

export const loadedLayouts = (layouts: Layouts): Layouts => ({
  ground: loadedLayout(layouts.ground),
  tower: loadedLayout(layouts.tower),
  tracon: loadedLayout(layouts.tracon),
})
