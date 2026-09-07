import { describe, expect, test } from 'bun:test'
import { Schema } from 'effect'

import {
  BAR_SHARE,
  KEEP_VISIBLE_PX,
  Layout,
  MIN_FLOAT_W,
  MIN_SHARE,
  type Node,
  PANELS,
  availablePanels,
  close,
  defaultLayouts,
  dock,
  fitFloating,
  insertBeside,
  leaves,
  loadedLayout,
  moveFloating,
  normalise,
  open,
  openFloating,
  panelsOf,
  placement,
  prune,
  raise,
  remove,
  resizeAt,
  resizeFloating,
  splitAt,
  swap,
  toggle,
  toggleFloat,
} from '../src/app/layout'
import { edgeAt } from '../src/app/commands'

const ws = { width: 1400, height: 900 }
const ground = defaultLayouts.ground
const rootOf = (l: Layout): Node => l.root!

describe('layout tree', () => {
  test('the defaults tile controls over the scopes and strips over the console, and decode through the Schema', () => {
    expect(panelsOf(ground.root)).toEqual(['controls', 'asdex', 'strips', 'console'])
    expect(panelsOf(defaultLayouts.tower.root)).toEqual(['controls', 'asdex', 'stars', 'strips', 'console'])
    expect(panelsOf(defaultLayouts.tracon.root)).toEqual(['controls', 'stars', 'strips', 'console'])
    expect(Schema.decodeUnknownSync(Layout)(JSON.parse(JSON.stringify(ground)))).toEqual(ground)
    expect(Schema.decodeUnknownOption(Layout)({ root: { _tag: 'Leaf', panel: 'nope' }, floating: [], rects: {} })._tag).toBe('None')
    expect(leaves(ground.root).map((l) => [l.panel, l.path])).toEqual([
      ['controls', [0]],
      ['asdex', [1, 0]],
      ['strips', [1, 1]],
      ['console', [2]],
    ])
  })

  test('removing a leaf collapses its split; removing the last leaf empties the tree', () => {
    const without = remove(ground.root, 'strips')!
    expect(without._tag).toBe('Split')
    expect(panelsOf(without)).toEqual(['controls', 'asdex', 'console'])
    expect(splitAt(without, [])!.children[1]).toEqual({ _tag: 'Leaf', panel: 'asdex' })
    expect(splitAt(without, [])!.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
    expect(remove(remove(remove(without, 'controls'), 'asdex'), 'console')).toBeNull()
    expect(remove(null, 'asdex')).toBeNull()
  })

  test('inserting beside a leaf joins the parent when it runs that way, else wraps the leaf as a two-way split', () => {
    const joined = insertBeside(ground.root, 'asdex', 'stars', 'right')!
    const row = splitAt(joined, [1])!
    expect(row.children.map((c) => (c._tag === 'Leaf' ? c.panel : '?'))).toEqual(['asdex', 'stars', 'strips'])
    expect(row.sizes[0]).toBeCloseTo(0.39)
    expect(row.sizes[1]).toBeCloseTo(0.39)
    const wrapped = insertBeside(ground.root, 'asdex', 'rewind', 'bottom')!
    const inner = splitAt(wrapped, [1, 0])!
    expect(inner.dir).toBe('col')
    expect(panelsOf(inner)).toEqual(['asdex', 'rewind'])
    expect(inner.sizes).toEqual([0.5, 0.5])
    const before = insertBeside(ground.root, 'asdex', 'rewind', 'top')!
    expect(panelsOf(splitAt(before, [1, 0]))).toEqual(['rewind', 'asdex'])
    expect(insertBeside(null, 'asdex', 'rewind', 'left')).toEqual({ _tag: 'Leaf', panel: 'rewind' })
    expect(insertBeside(ground.root, 'asdex', 'rewind', 'center')).toBe(ground.root)
  })

  test('swap exchanges two leaves; normalise repairs sizes and collapses single-child splits', () => {
    expect(panelsOf(swap(ground.root, 'asdex', 'console'))).toEqual(['controls', 'console', 'strips', 'asdex'])
    const messy: Node = { _tag: 'Split', dir: 'row', children: [{ _tag: 'Split', dir: 'col', children: [{ _tag: 'Leaf', panel: 'asdex' }], sizes: [] }, { _tag: 'Leaf', panel: 'strips' }], sizes: [Number.NaN, -3] }
    const fixed = normalise(messy)!
    expect(fixed).toEqual({ _tag: 'Split', dir: 'row', children: [{ _tag: 'Leaf', panel: 'asdex' }, { _tag: 'Leaf', panel: 'strips' }], sizes: [0.5, 0.5] })
  })

  test('a gutter drag trades share between its neighbours, each keeping the minimum', () => {
    const half = resizeAt(ground.root, [1], 0, 0.5)!
    expect(splitAt(half, [1])!.sizes.map((s) => Math.round(s * 100) / 100)).toEqual([0.5, 0.5])
    const pinned = resizeAt(ground.root, [1], 0, 2)!
    expect(splitAt(pinned, [1])!.sizes[1]).toBeCloseTo(MIN_SHARE)
    const middle = resizeAt(ground.root, [], 1, 0.5)!
    const sizes = splitAt(middle, [])!.sizes
    expect(sizes[0]).toBeCloseTo(BAR_SHARE)
    expect(sizes[0]! + sizes[1]!).toBeCloseTo(0.5)
    expect(sizes[2]).toBeCloseTo(0.5)
    expect(resizeAt(ground.root, [1], 5, 0.5)).toEqual(ground.root)
    expect(resizeAt(ground.root, [9], 0, 0.5)).toEqual(ground.root)
  })
})

describe('windows', () => {
  test('open tiles a panel beside its docking partner or at the root edge; transient panels float, centred', () => {
    const rewound = open(ground, 'rewind', ws)
    expect(placement(rewound, 'rewind')).toBe('tiled')
    expect(panelsOf(rewound.root)).toEqual(['controls', 'asdex', 'strips', 'rewind', 'console'])
    expect(splitAt(rewound.root, [])!.sizes[2]).toBeCloseTo(0.14)
    expect(splitAt(rewound.root, [])!.sizes[3]).toBeCloseTo(0.14)
    const settings = open(ground, 'settings', ws)
    expect(placement(settings, 'settings')).toBe('floating')
    expect(settings.floating[0]).toEqual({ panel: 'settings', x: 320, y: 140, w: 760, h: 620 })
    expect(open(settings, 'settings', ws)).toBe(settings)
    const second = open(settings, 'commands', ws)
    expect(second.floating[1]!.x).toBe(344)
    const noStars = remove(defaultLayouts.tower.root, 'stars')
    const starsBack = open({ ...defaultLayouts.tower, root: noStars }, 'stars', ws)
    expect(panelsOf(starsBack.root)).toEqual(['controls', 'asdex', 'stars', 'strips', 'console'])
    const bare = open({ root: null, floating: [], rects: {} }, 'console', ws)
    expect(bare.root).toEqual({ _tag: 'Leaf', panel: 'console' })
    const withControls = open(bare, 'controls', ws)
    expect(panelsOf(withControls.root)).toEqual(['controls', 'console'])
    expect(splitAt(withControls.root, [])!.sizes[0]).toBeCloseTo(BAR_SHARE)
  })

  test('close removes a window and remembers where it floated; toggle goes both ways', () => {
    const floated = openFloating(ground, 'strips', ws)
    const moved = moveFloating(floated, 'strips', 100, 200, ws)
    const closed = close(moved, 'strips')
    expect(placement(closed, 'strips')).toBeNull()
    expect(closed.rects['strips']).toEqual({ x: 100, y: 200, w: 320, h: 520 })
    expect(openFloating(closed, 'strips', ws).floating[0]).toEqual({ panel: 'strips', x: 100, y: 200, w: 320, h: 520 })
    expect(placement(toggle(ground, 'strips', ws), 'strips')).toBeNull()
    expect(placement(toggle(toggle(ground, 'strips', ws), 'strips', ws), 'strips')).toBe('tiled')
  })

  test('float and tile again keep the tree sane and the floating rect remembered', () => {
    const floated = toggleFloat(ground, 'asdex', ws)
    expect(placement(floated, 'asdex')).toBe('floating')
    expect(panelsOf(floated.root)).toEqual(['controls', 'strips', 'console'])
    const tiled = toggleFloat(floated, 'asdex', ws)
    expect(placement(tiled, 'asdex')).toBe('tiled')
    expect(tiled.floating).toEqual([])
    expect(tiled.rects['asdex']).toMatchObject({ w: 720, h: 520 })
    expect(panelsOf(splitAt(tiled.root, [1]))).toEqual(['asdex', 'strips'])
  })

  test('dropping a window on a tile docks it there; the centre swaps tiles or docks a floating window to the right', () => {
    const docked = dock(ground, 'strips', 'console', 'left')
    expect(panelsOf(docked.root)).toEqual(['controls', 'asdex', 'strips', 'console'])
    expect(splitAt(docked.root, [])!.children[1]).toEqual({ _tag: 'Leaf', panel: 'asdex' })
    expect(splitAt(docked.root, [2])!.dir).toBe('row')
    expect(panelsOf(splitAt(docked.root, [2]))).toEqual(['strips', 'console'])
    expect(panelsOf(dock(ground, 'strips', 'asdex', 'center').root)).toEqual(['controls', 'strips', 'asdex', 'console'])
    const floated = toggleFloat(ground, 'strips', ws)
    const back = dock(floated, 'strips', 'asdex', 'center')
    expect(back.floating).toEqual([])
    expect(panelsOf(splitAt(back.root, [1]))).toEqual(['asdex', 'strips'])
    expect(dock(ground, 'strips', 'strips', 'left')).toBe(ground)
    expect(dock(ground, 'strips', 'rewind', 'left')).toBe(ground)
  })

  test('floating windows stay on screen, resize from their grips, and raise to the top', () => {
    const two = openFloating(openFloating(ground, 'settings', ws), 'commands', ws)
    expect(two.floating.map((f) => f.panel)).toEqual(['settings', 'commands'])
    expect(raise(two, 'settings').floating.map((f) => f.panel)).toEqual(['commands', 'settings'])
    expect(raise(two, 'commands')).toBe(two)
    const far = moveFloating(two, 'settings', 5000, 5000, ws)
    expect(far.floating[0]).toMatchObject({ x: ws.width - KEEP_VISIBLE_PX, y: ws.height - 26 })
    const left = moveFloating(two, 'settings', -5000, -50, ws)
    expect(left.floating[0]).toMatchObject({ x: KEEP_VISIBLE_PX - 760, y: 0 })
    const small = resizeFloating(two, 'settings', 'corner', 0, 0)
    expect(small.floating[0]).toMatchObject({ w: MIN_FLOAT_W, h: 120 })
    const wide = resizeFloating(two, 'settings', 'right', 1000, 0)
    expect(wide.floating[0]).toMatchObject({ w: 680, h: 620 })
    const fitted = fitFloating(far, { width: 800, height: 600 })
    expect(fitted.floating[0]!.x).toBe(800 - KEEP_VISIBLE_PX)
    expect(fitFloating(far, { width: 0, height: 0 })).toBe(far)
  })

  test('prune drops the panels a position lacks; loading closes transient windows and repairs the tree', () => {
    expect(availablePanels('ground')).not.toContain('stars')
    expect(availablePanels('tracon')).not.toContain('asdex')
    expect(availablePanels('tower')).toEqual(PANELS.filter((p) => p !== 'eram'))
    expect(availablePanels('center')).toEqual(PANELS.filter((p) => p !== 'asdex' && p !== 'stars'))
    expect(panelsOf(defaultLayouts.center.root)).toEqual(['controls', 'eram', 'strips', 'console'])
    expect(PANELS).toContain('scenarios')
    expect(panelsOf(prune(defaultLayouts.tower, availablePanels('ground')).root)).toEqual(['controls', 'asdex', 'strips', 'console'])
    const loaded = loadedLayout(open(open(ground, 'settings', ws), 'rewind', ws))
    expect(placement(loaded, 'settings')).toBeNull()
    expect(placement(loaded, 'rewind')).toBe('tiled')
    expect(loaded.rects['settings']).toBeDefined()
  })

  test('the drop edge is the nearest side within the outer quarter, else the centre', () => {
    expect(edgeAt(0.1, 0.5)).toBe('left')
    expect(edgeAt(0.95, 0.5)).toBe('right')
    expect(edgeAt(0.5, 0.05)).toBe('top')
    expect(edgeAt(0.5, 0.9)).toBe('bottom')
    expect(edgeAt(0.5, 0.5)).toBe('center')
    expect(edgeAt(0.3, 0.3)).toBe('center')
    expect(edgeAt(0.1, 0.2)).toBe('left')
  })

  test('the tree stays well-formed through a random walk of operations', () => {
    let layout = ground
    let seed = 7
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(rand() * xs.length)]!
    const edges = ['left', 'right', 'top', 'bottom', 'center'] as const
    for (let i = 0; i < 400; i++) {
      const panel = pick(PANELS)
      const op = Math.floor(rand() * 5)
      layout =
        op === 0 ? toggle(layout, panel, ws) : op === 1 ? toggleFloat(layout, panel, ws) : op === 2 ? dock(layout, panel, pick(PANELS), pick(edges)) : op === 3 ? close(layout, panel) : open(layout, panel, ws)
      const tiled = panelsOf(layout.root)
      expect(new Set(tiled).size).toBe(tiled.length)
      for (const f of layout.floating) {
        expect(tiled).not.toContain(f.panel)
      }
      const check = (n: Node | null) => {
        if (n === null || n._tag === 'Leaf') {
          return
        }
        expect(n.children.length).toBeGreaterThan(1)
        expect(n.sizes).toHaveLength(n.children.length)
        expect(n.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
        n.children.forEach(check)
      }
      check(layout.root)
      expect(Schema.decodeUnknownOption(Layout)(layout)._tag).toBe('Some')
    }
    expect(rootOf(open(layout, 'console', ws))).toBeDefined()
  })
})
