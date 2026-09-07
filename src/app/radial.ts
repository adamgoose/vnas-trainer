/**
 * The radial command menu on the ASDE-X scope (pure): what a click on an aircraft
 * offers, ring by ring. A ring holds at most MAX_ITEMS entries (longer lists page
 * through a "more" entry); an entry either opens the next ring or ends in a command
 * line the parser accepts, so a menu pick and a typed command go the same way.
 */
import type { Aircraft } from '../domain/aircraft'
import type { LonLat } from '../domain/catalog'
import { distanceFt } from '../domain/geo'
import { type Graph, edgeName, isRunwayName, runwaysEntered } from '../domain/graph'
import { holdTarget } from '../domain/physics'
import type { World } from '../domain/world'
import type { PositionMode } from '../positions'

export type RadialItem = Readonly<{
  key: string
  /** the command mnemonic, or the value this entry supplies */
  label: string
  /** opens another ring rather than issuing a command */
  opens: boolean
  next: () => RadialNode
}>

export type RadialNode =
  | Readonly<{ _tag: 'Menu'; title: string; items: ReadonlyArray<RadialItem> }>
  | Readonly<{ _tag: 'Line'; line: string }>

export const MAX_ITEMS = 12

const line = (text: string): RadialNode => ({ _tag: 'Line', line: text })

const leaf = (key: string, label: string, text: string): RadialItem => ({ key, label, opens: false, next: () => line(text) })

const menu = (key: string, label: string, next: () => RadialNode): RadialItem => ({ key, label, opens: true, next })

/** A ring of at most MAX_ITEMS entries; the rest follow a "more" entry. */
const paged = (title: string, items: ReadonlyArray<RadialItem>): RadialNode =>
  items.length <= MAX_ITEMS
    ? { _tag: 'Menu', title, items }
    : { _tag: 'Menu', title, items: [...items.slice(0, MAX_ITEMS - 1), menu('more', '…', () => paged(title, items.slice(MAX_ITEMS - 1)))] }

const pad3 = (heading: number): string => String(heading === 0 ? 360 : heading).padStart(3, '0')

// AIRFIELD LOOKUPS

const positionOf = (graph: Graph, a: Aircraft): LonLat => (a.state === 'PARKED' && a.gate !== null ? (graph.parking[a.gate]?.c ?? a.position) : a.position)

const nearestDistance = (graph: Graph, nodes: ReadonlyArray<number>, from: LonLat): number =>
  nodes.reduce((best, n) => Math.min(best, distanceFt(graph.projection, graph.nodes[n]!, from)), Infinity)

/** Every taxiway, nearest to `from` first. */
const taxiwaysNear = (graph: Graph, from: LonLat): ReadonlyArray<string> =>
  Object.entries(graph.taxiways)
    .map(([name, nodes]) => [name, nearestDistance(graph, nodes, from)] as const)
    .sort((x, y) => x[1] - y[1])
    .map(([name]) => name)

/** The taxiways that meet `name`, nearest junction to `from` first. */
const taxiwaysJoining = (graph: Graph, name: string, from: LonLat): ReadonlyArray<string> => {
  const distance = new Map<string, number>()
  for (const n of graph.taxiways[name] ?? []) {
    const d = distanceFt(graph.projection, graph.nodes[n]!, from)
    for (const other of graph.nodeTaxiways[n] ?? []) {
      if (other !== name && d < (distance.get(other) ?? Infinity)) {
        distance.set(other, d)
      }
    }
  }
  return [...distance.entries()].sort((x, y) => x[1] - y[1]).map(([other]) => other)
}

/** Taxiways and runways still ahead on the route, in route order. */
const pointsAhead = (graph: Graph, a: Aircraft): ReadonlyArray<string> => {
  const out: Array<string> = []
  if (a.path === null) {
    return out
  }
  for (let i = a.leg; i + 1 < a.path.length; i++) {
    const from = a.path[i]!
    const to = a.path[i + 1]!
    for (const runway of runwaysEntered(graph, from, to)) {
      if (!out.includes(runway)) {
        out.push(runway)
      }
    }
    const name = edgeName(graph, from, to)
    if (name !== null && !out.includes(name)) {
      out.push(name)
    }
  }
  return out
}

const runwayDesignators = (graph: Graph): ReadonlyArray<string> => Object.keys(graph.runwayEnds)

// TAXI ROUTES

type Route = Readonly<{ runway: string | null; via: ReadonlyArray<string>; cross: ReadonlyArray<string>; holdShort: string | null }>

const routeLine = (r: Route): string =>
  [
    r.runway !== null ? `RWY ${r.runway}` : 'TAXI',
    ...(r.runway !== null && r.via.length > 0 ? ['TAXI'] : []),
    ...r.via,
    ...(r.cross.length > 0 ? ['CROSS', ...r.cross] : []),
    ...(r.holdShort !== null ? ['HS', r.holdShort] : []),
  ].join(' ')

const TAXIWAYS_PER_RING = 8

/**
 * Build a taxi clearance a clause at a time: taxiways that meet the last one
 * named (or lie near the aircraft), crossings, a hold-short point to finish, and
 * "go" to issue what has been built so far.
 */
const routeBuilder = (graph: Graph, a: Aircraft, r: Route, page = 0): RadialNode => {
  const title = routeLine(r)
  const from = positionOf(graph, a)
  const last = r.via[r.via.length - 1]
  const candidates = (last === undefined || graph.taxiways[last] === undefined ? taxiwaysNear(graph, from) : taxiwaysJoining(graph, last, from)).filter(
    (t) => !r.via.includes(t),
  )
  const complete = r.runway !== null || r.via.length > 0
  const withVia = (name: string): RadialNode => routeBuilder(graph, a, { ...r, via: [...r.via, name] })
  const fixed: Array<RadialItem> = [
    ...(complete ? [leaf('go', 'GO', title)] : []),
    ...(a.destinationGate !== null && r.runway === null && !r.via.includes(a.destinationGate)
      ? [leaf(`g:${a.destinationGate}`, a.destinationGate, routeLine({ ...r, via: [...r.via, a.destinationGate] }))]
      : []),
    ...(complete
      ? [
          menu('x', 'CROSS', () =>
            paged(
              `${title} CROSS`,
              runwayDesignators(graph)
                .filter((d) => !r.cross.includes(d))
                .map((d) => menu(`r:${d}`, d, () => routeBuilder(graph, a, { ...r, cross: [...r.cross, d] }))),
            ),
          ),
          menu('hs', 'HS', () =>
            paged(`${title} HS`, [...runwayDesignators(graph), ...r.via.filter((t) => graph.taxiways[t] !== undefined)].map((p) => leaf(`p:${p}`, p, routeLine({ ...r, holdShort: p })))),
          ),
        ]
      : []),
  ]
  const shown = candidates.slice(page * TAXIWAYS_PER_RING, (page + 1) * TAXIWAYS_PER_RING)
  const more = candidates.length > (page + 1) * TAXIWAYS_PER_RING ? [menu('more', '…', () => routeBuilder(graph, a, r, page + 1))] : []
  return { _tag: 'Menu', title, items: [...fixed, ...shown.map((t) => menu(`t:${t}`, t, () => withVia(t))), ...more] }
}

const runwayMenu = (graph: Graph, a: Aircraft): RadialNode =>
  paged('RWY', runwayDesignators(graph).map((d) => menu(`r:${d}`, d, () => routeBuilder(graph, a, { runway: d, via: [], cross: [], holdShort: null }))))

const taxiMenu = (graph: Graph, a: Aircraft): RadialNode => routeBuilder(graph, a, { runway: null, via: [], cross: [], holdShort: null })

// AIRBORNE VALUES

/** Twelve 30° sectors, laid out like a compass, each opening the 5° headings within it. */
const headingMenu = (title: string, prefix: string): RadialNode => ({
  _tag: 'Menu',
  title,
  items: Array.from({ length: 12 }, (_, s) => {
    const base = s * 30
    return menu(`h:${base}`, pad3(base), () => ({
      _tag: 'Menu',
      title: `${title} ${pad3(base)}`,
      items: Array.from({ length: 6 }, (_, i) => {
        const heading = base + i * 5
        return leaf(`h:${heading}`, pad3(heading), `${prefix} ${pad3(heading)}`)
      }),
    }))
  }),
})

/** Fly heading, turn left, turn right: each a compass ring; `verbs` are the lines' leading words. */
const turnMenu = (verbs: Readonly<{ fly: string; left: string; right: string }>): ReadonlyArray<RadialItem> => [
  menu('fh', 'FH', () => headingMenu(verbs.fly, verbs.fly)),
  menu('tl', 'TL', () => headingMenu(verbs.left, verbs.left)),
  menu('tr', 'TR', () => headingMenu(verbs.right, verbs.right)),
]

const ALTITUDES = [2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000]
const SPEEDS = [170, 180, 190, 200, 210, 220, 230, 250, 280, 300]

const altitudeMenu = (a: Aircraft): RadialNode => ({
  _tag: 'Menu',
  title: 'CM / DM',
  items: ALTITUDES.map((alt) => leaf(`a:${alt}`, String(alt), `${alt > a.altitude ? 'CM' : 'DM'} ${alt}`)),
})

const speedMenu = (): RadialNode => ({
  _tag: 'Menu',
  title: 'SPD',
  items: [leaf('resume', 'SPD', 'SPD'), ...SPEEDS.map((kt) => leaf(`s:${kt}`, String(kt), `SPD ${kt}`))],
})

/** The fixes still to fly, then the rest of the filed route the airport's NavData knows. */
const fixesFor = (world: World, a: Aircraft): ReadonlyArray<string> => {
  const known = (f: string) => world.nav.fixes[f] !== undefined
  const filed = (a.flightPlan.route ?? '')
    .toUpperCase()
    .split(/\s+/)
    .filter((t) => t !== '' && known(t) && !a.fixes.includes(t))
  return [...a.fixes.filter(known), ...filed.filter((f, i) => filed.indexOf(f) === i)]
}

const squawkMenu = (digits: string): RadialNode => ({
  _tag: 'Menu',
  title: `SQ ${digits.padEnd(4, '·')}`,
  items: Array.from({ length: 8 }, (_, d) => {
    const code = digits + String(d)
    return code.length === 4 ? leaf(`d:${d}`, String(d), `SQ ${code}`) : menu(`d:${d}`, String(d), () => squawkMenu(code))
  }),
})

const moreMenu = (): RadialNode => ({
  _tag: 'Menu',
  title: 'more',
  items: [
    menu('sq', 'SQ', () => squawkMenu('')),
    leaf('id', 'ID', 'ID'),
    leaf('sn', 'SN', 'SN'),
    leaf('ss', 'SS', 'SS'),
    leaf('say', 'SAY', 'SAY'),
    leaf('gate', 'GATE', 'SAY GATE'),
    leaf('type', 'TYPE', 'SAY TYPE'),
    leaf('del', 'DEL', 'DEL'),
  ],
})

// ROOT

const contactNext = (world: World): RadialItem => leaf('cd', 'CD', 'CD')

const trackOrDrop = (a: Aircraft): ReadonlyArray<RadialItem> =>
  a.radar === null ? [] : a.tracked ? [leaf('drop', 'DROP', 'DROP')] : [leaf('track', 'TRACK', 'TRACK')]

const runwayItem = (graph: Graph, a: Aircraft) => menu('rwy', 'RWY', () => runwayMenu(graph, a))
const taxiItem = (graph: Graph, a: Aircraft) => menu('taxi', 'TAXI', () => taxiMenu(graph, a))
const holdShortItem = (graph: Graph, a: Aircraft): ReadonlyArray<RadialItem> => {
  const points = pointsAhead(graph, a)
  return points.length === 0 ? [] : [menu('hs', 'HS', () => paged('HS', points.map((p) => leaf(`p:${p}`, p, `HS ${p}`))))]
}
const crossItem = (graph: Graph, a: Aircraft): ReadonlyArray<RadialItem> => {
  const held = holdTarget(graph, a)
  const ahead = pointsAhead(graph, a).filter((p) => isRunwayName(graph, p) && p !== held)
  if (held === null && ahead.length === 0) {
    return []
  }
  const first = held === null ? [] : [leaf('x', held, 'CROSS')]
  return ahead.length === 0
    ? first
    : [menu('x', 'CROSS', () => paged('CROSS', [...first, ...ahead.map((r) => leaf(`r:${r}`, r, `CROSS ${r}`))]))]
}
const giveWayItem = (world: World, a: Aircraft): ReadonlyArray<RadialItem> => {
  const others = world.aircraft
    .filter((o) => o.callsign !== a.callsign && o.delay <= 0 && o.state !== 'AIRB' && o.state !== 'FINAL')
    .map((o) => [o.callsign, distanceFt(world.graph.projection, o.position, a.position)] as const)
    .sort((x, y) => x[1] - y[1])
    .map(([callsign]) => callsign)
  return others.length === 0 ? [] : [menu('gw', 'GW', () => paged('GW', others.map((c) => leaf(`c:${c}`, c, `GW ${c}`))))]
}
const departureItems = (a: Aircraft): ReadonlyArray<RadialItem> =>
  a.runway === null
    ? []
    : [
        leaf('luaw', 'LUAW', 'LUAW'),
        menu('cto', 'CTO', () => ({
          _tag: 'Menu',
          title: 'CTO',
          items: [leaf('go', 'CTO', 'CTO'), ...turnMenu({ fly: 'CTO', left: 'CTO L', right: 'CTO R' })],
        })),
      ]
const moreItem = menu('more', '…', moreMenu)

const airborneItems = (world: World, mode: PositionMode, a: Aircraft): ReadonlyArray<RadialItem> => {
  const graph = world.graph
  const fixes = fixesFor(world, a)
  const direct = fixes.length === 0 ? [] : [menu('dct', 'DCT', () => paged('DCT', fixes.map((f) => leaf(`f:${f}`, f, `DCT ${f}`))))]
  const shared = [
    menu('alt', 'CM/DM', () => altitudeMenu(a)),
    menu('spd', 'SPD', speedMenu),
    ...direct,
    menu('hdg', 'FH', () => ({ _tag: 'Menu', title: 'FH', items: turnMenu({ fly: 'FH', left: 'TL', right: 'TR' }) })),
  ]
  if (mode === 'tracon') {
    return [
      ...shared,
      menu('exp', 'EXP', () => paged('EXP', runwayDesignators(graph).map((d) => leaf(`r:${d}`, d, `EXP ${d}`)))),
      menu('capp', 'CAPP', () =>
        paged('CAPP', [
          ...(a.runway === null ? [] : [leaf('go', a.runway, 'CAPP')]),
          ...runwayDesignators(graph)
            .filter((d) => d !== a.runway)
            .map((d) => leaf(`r:${d}`, d, `CAPP ${d}`)),
        ]),
      ),
      ...(a.handoff ? [] : [leaf('ct', 'CT', 'CT'), contactNext(world)]),
      ...trackOrDrop(a),
    ]
  }
  return [...trackOrDrop(a), ...(a.handoff ? [] : [contactNext(world)]), ...shared]
}

/** The first ring for an aircraft: the instructions that make sense in its state. */
export const radialRoot = (world: World, mode: PositionMode, a: Aircraft): RadialNode => {
  const graph = world.graph
  const items = ((): ReadonlyArray<RadialItem> => {
    switch (a.state) {
      case 'PARKED':
        return [
          menu('push', 'PUSH', () =>
            paged('PUSH', [leaf('go', 'PUSH', 'PUSH'), ...taxiwaysNear(graph, positionOf(graph, a)).map((t) => leaf(`t:${t}`, t, `PUSH ${t}`))]),
          ),
          runwayItem(graph, a),
          taxiItem(graph, a),
        ]
      case 'PUSH':
      case 'PUSHED':
        return [runwayItem(graph, a), taxiItem(graph, a), ...(a.state === 'PUSHED' ? [leaf('res', 'RES', 'RES')] : []), leaf('hold', 'HOLD', 'HOLD')]
      case 'TAXI':
        return [
          runwayItem(graph, a),
          taxiItem(graph, a),
          ...holdShortItem(graph, a),
          ...crossItem(graph, a),
          leaf('hold', 'HOLD', 'HOLD'),
          leaf('break', 'BREAK', 'BREAK'),
          ...giveWayItem(world, a),
          ...departureItems(a),
        ]
      case 'SHORT':
        return [
          ...crossItem(graph, a),
          leaf('res', 'RES', 'RES'),
          runwayItem(graph, a),
          taxiItem(graph, a),
          ...holdShortItem(graph, a),
          ...giveWayItem(world, a),
          ...departureItems(a),
        ]
      case 'HOLD':
        return [
          leaf('res', 'RES', 'RES'),
          runwayItem(graph, a),
          taxiItem(graph, a),
          ...crossItem(graph, a),
          ...holdShortItem(graph, a),
          leaf('break', 'BREAK', 'BREAK'),
          ...giveWayItem(world, a),
          ...departureItems(a),
          leaf('exit', 'EXIT', 'EXIT'),
        ]
      case 'ROLLOUT':
        return [leaf('exit', 'EXIT', 'EXIT'), taxiItem(graph, a), leaf('hold', 'HOLD', 'HOLD')]
      case 'LUAW':
        return departureItems(a).filter((i) => i.key === 'cto')
      case 'TKOF':
        return [...(a.handoff ? [] : [contactNext(world)]), ...trackOrDrop(a)]
      case 'FINAL':
        return [
          ...(a.clearedToLand ? [] : [leaf('ctl', 'CTL', 'CTL')]),
          leaf('ga', 'GA', 'GA'),
          ...(mode === 'tracon' && !a.handoff ? [leaf('ct', 'CT', 'CT')] : []),
          ...trackOrDrop(a),
        ]
      case 'AIRB':
        return airborneItems(world, mode, a)
    }
  })()
  return paged(a.callsign, [...items, moreItem])
}

/** The ring (or the command line) reached by following `trail` from the root; null when a key is stale. */
export const radialAt = (world: World, mode: PositionMode, a: Aircraft, trail: ReadonlyArray<string>): RadialNode | null => {
  let node = radialRoot(world, mode, a)
  for (const key of trail) {
    if (node._tag !== 'Menu') {
      return null
    }
    const item = node.items.find((i) => i.key === key)
    if (item === undefined) {
      return null
    }
    node = item.next()
  }
  return node
}
