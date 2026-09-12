/**
 * The radial command menu on the ASDE-X scope (pure): what a click on an aircraft
 * offers, ring by ring. A ring holds at most MAX_ITEMS entries (longer lists page
 * through a "more" entry); an entry either opens the next ring or ends in a command
 * line the parser accepts, so a menu pick and a typed command go the same way.
 */
import type { Aircraft } from '../domain/aircraft'
import type { LonLat } from '../domain/catalog'
import { distanceFt } from '../domain/geo'
import { type Graph, edgeName, isRunwayName, runwayEntries, runwaysEntered } from '../domain/graph'
import { FINAL_KT, holdTarget, rollFt, runwayExits } from '../domain/physics'
import type { World } from '../domain/world'
import type { PositionMode } from '../positions'
import { type PlanPreview, type RoutePlan, newPlan, planLine, planPreview, setEntry, toggleCross, toggleWaypoint } from './plan'

export type RadialItem = Readonly<{
  key: string
  /** the command mnemonic, or the value this entry supplies */
  label: string
  /** opens another ring rather than issuing a command */
  opens: boolean
  next: () => RadialNode
}>

export type RadialNode =
  | Readonly<{ _tag: 'Menu'; title: string; items: ReadonlyArray<RadialItem>; pick?: 'runway' }>
  /** a taxi clearance proposed on the scope (src/app/plan.ts): GO issues its line, the scope edits it */
  | Readonly<{ _tag: 'Plan'; title: string; plan: RoutePlan; items: ReadonlyArray<RadialItem> }>
  | Readonly<{ _tag: 'Line'; line: string }>
  | Readonly<{ _tag: 'Close' }>

export const MAX_ITEMS = 12

const line = (text: string): RadialNode => ({ _tag: 'Line', line: text })

const leaf = (key: string, label: string, text: string): RadialItem => ({ key, label, opens: false, next: () => line(text) })

const menu = (key: string, label: string, next: () => RadialNode): RadialItem => ({ key, label, opens: true, next })

/** A ring of at most MAX_ITEMS entries; the rest follow a "more" entry. `pick` marks every page of a runway ring. */
const paged = (title: string, items: ReadonlyArray<RadialItem>, pick?: 'runway'): RadialNode => {
  const flag = pick === undefined ? {} : { pick }
  return items.length <= MAX_ITEMS
    ? { _tag: 'Menu', title, items, ...flag }
    : { _tag: 'Menu', title, items: [...items.slice(0, MAX_ITEMS - 1), menu('more', '…', () => paged(title, items.slice(MAX_ITEMS - 1), pick))], ...flag }
}

/** Keys from a ring to the entry `key`, following "more" pages; null when the ring has no such entry. */
export const trailTo = (node: RadialNode, key: string): ReadonlyArray<string> | null => {
  const trail: Array<string> = []
  let at = node
  for (;;) {
    if (at._tag !== 'Menu') {
      return null
    }
    if (at.items.some((i) => i.key === key)) {
      return [...trail, key]
    }
    const more = at.items.find((i) => i.key === 'more')
    if (more === undefined) {
      return null
    }
    trail.push('more')
    at = more.next()
  }
}

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

// RUNWAY PLAN

const closeItem: RadialItem = { key: 'cancel', label: '✕', opens: false, next: () => ({ _tag: 'Close' }) }

/** The ring over a proposed clearance: accept it, pick the taxiway to enter the runway from, or reject it. Its title is the line GO issues. */
const planNode = (world: World, a: Aircraft, plan: RoutePlan): RadialNode => {
  const line = planLine(world.graph, a, plan)
  const entries = runwayEntries(world.graph, plan.runway)
  const at = entries.length === 0 ? [] : [menu('at', 'AT', () => paged(`${line} AT`, entries.map((e) => menu(`e:${e.taxiway}`, e.taxiway, () => planNode(world, a, setEntry(world.graph, plan, e.taxiway))))))]
  return { _tag: 'Plan', title: line, plan, items: [leaf('go', 'GO', line), ...at, closeItem] }
}

/** A scope click on the plan: `e:<taxiway>` enters the runway there, `n:<node>` sends the route through an intersection, `x:<runway>` toggles a crossing. */
const editPlan = (graph: Graph, plan: RoutePlan, key: string): RoutePlan | null => {
  if (key.startsWith('e:')) {
    return setEntry(graph, plan, key.slice(2))
  }
  if (key.startsWith('n:')) {
    const node = Number(key.slice(2))
    return Number.isInteger(node) ? toggleWaypoint(plan, node) : null
  }
  return key.startsWith('x:') ? toggleCross(plan, key.slice(2)) : null
}

/** Runway ends; each opens a plan for the route to it. The scope offers the same picks as buttons on the runway numbers. */
const runwayMenu = (world: World, a: Aircraft): RadialNode =>
  paged('RWY', runwayDesignators(world.graph).map((d) => menu(`r:${d}`, d, () => planNode(world, a, newPlan(d)))), 'runway')

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

const runwayItem = (world: World, a: Aircraft) => menu('rwy', 'RWY', () => runwayMenu(world, a))
/** TAXI only continues a clearance: to the assigned runway, or an arrival to its gate. */
const taxiItem = (graph: Graph, a: Aircraft): ReadonlyArray<RadialItem> =>
  a.runway === null && a.destinationGate === null ? [] : [menu('taxi', 'TAXI', () => taxiMenu(graph, a))]
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
/** EXIT: the taxiways ahead the aircraft can still slow for (the whole runway on final), plus a bare EXIT on the roll. */
const exitItems = (graph: Graph, a: Aircraft): ReadonlyArray<RadialItem> => {
  const end = a.runway !== null ? graph.runwayEnds[a.runway] : undefined
  if (end === undefined || a.path === null) {
    return []
  }
  const onFinal = a.state === 'FINAL'
  const k = onFinal ? 0 : end.chain.indexOf(a.path[a.leg + 1] ?? -1)
  if (k < 0) {
    return []
  }
  const from = onFinal ? graph.nodes[end.chain[0]!]! : a.position
  const minFt = rollFt(onFinal ? FINAL_KT : a.speed)
  const names = [...new Set(runwayExits(graph, end, k, from).filter((e) => e.runwayFt >= minFt).map((e) => e.taxiway))]
  const bare = onFinal ? [] : [leaf('exit', 'EXIT', 'EXIT')]
  if (names.length === 0) {
    return bare
  }
  return [menu('exit', 'EXIT', () => paged('EXIT', [...bare, ...names.map((n) => leaf(`e:${n}`, n, `EXIT ${n}`))]))]
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
  if (mode === 'center') {
    return [...shared, ...(a.handoff ? [] : [leaf('ca', 'CA', 'CA'), contactNext(world)]), ...trackOrDrop(a)]
  }
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
          runwayItem(world, a),
          ...taxiItem(graph, a),
        ]
      case 'PUSH':
      case 'PUSHED':
        return [runwayItem(world, a), ...taxiItem(graph, a), ...(a.state === 'PUSHED' ? [leaf('res', 'RES', 'RES')] : []), leaf('hold', 'HOLD', 'HOLD')]
      case 'TAXI':
        return [
          runwayItem(world, a),
          ...taxiItem(graph, a),
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
          runwayItem(world, a),
          ...taxiItem(graph, a),
          ...holdShortItem(graph, a),
          ...giveWayItem(world, a),
          ...departureItems(a),
        ]
      case 'HOLD':
        return [
          leaf('res', 'RES', 'RES'),
          runwayItem(world, a),
          ...taxiItem(graph, a),
          ...crossItem(graph, a),
          ...holdShortItem(graph, a),
          leaf('break', 'BREAK', 'BREAK'),
          ...giveWayItem(world, a),
          ...departureItems(a),
          leaf('exit', 'EXIT', 'EXIT'),
        ]
      case 'ROLLOUT':
        return [...exitItems(graph, a), ...taxiItem(graph, a), leaf('hold', 'HOLD', 'HOLD')]
      case 'LUAW':
        return departureItems(a).filter((i) => i.key === 'cto')
      case 'TKOF':
        return [...(a.handoff ? [] : [contactNext(world)]), ...trackOrDrop(a)]
      case 'FINAL':
        return [
          ...(a.clearedToLand ? [] : [leaf('ctl', 'CTL', 'CTL')]),
          leaf('ga', 'GA', 'GA'),
          ...exitItems(graph, a),
          ...(mode === 'tracon' && !a.handoff ? [leaf('ct', 'CT', 'CT')] : []),
          ...trackOrDrop(a),
        ]
      case 'AIRB':
        return airborneItems(world, mode, a)
    }
  })()
  return paged(a.callsign, [...items, moreItem])
}

export const INTERSECTION_HIT_FRACTION = 0.018

export type OpenPlan = Readonly<{ aircraft: Aircraft; plan: RoutePlan; trail: ReadonlyArray<string>; preview: PlanPreview }>

/** The plan open on the ring, if the ring is at one, with its preview on the world. */
export const openPlan = (world: World, mode: PositionMode, radial: Readonly<{ callsign: string; trail: ReadonlyArray<string> }> | null): OpenPlan | null => {
  if (radial === null) {
    return null
  }
  const aircraft = world.aircraft.find((a) => a.callsign === radial.callsign)
  if (aircraft === undefined || aircraft.delay > 0) {
    return null
  }
  const node = radialAt(world, mode, aircraft, radial.trail)
  return node === null || node._tag !== 'Plan' ? null : { aircraft, plan: node.plan, trail: radial.trail, preview: planPreview(world, aircraft, node.plan) }
}

/** Whether the ring at `node` is choosing a runway: the runway ring itself, or a root that offers one. */
export const offersRunways = (node: RadialNode): boolean => node._tag === 'Menu' && (node.pick === 'runway' || node.items.some((i) => i.key === 'rwy'))

/** The keys that pick runway end `designator` from the ring at `node`, or null when it offers none. */
export const runwayPickTrail = (node: RadialNode, designator: string): ReadonlyArray<string> | null => {
  if (node._tag !== 'Menu') {
    return null
  }
  if (node.pick === 'runway') {
    return trailTo(node, `r:${designator}`)
  }
  const rwy = node.items.find((i) => i.key === 'rwy')
  if (rwy === undefined) {
    return null
  }
  const rest = trailTo(rwy.next(), `r:${designator}`)
  return rest === null ? null : ['rwy', ...rest]
}

/** The ring (or the command line) reached by following `trail` from the root; null when a key is stale. */
export const radialAt = (world: World, mode: PositionMode, a: Aircraft, trail: ReadonlyArray<string>): RadialNode | null => {
  let node = radialRoot(world, mode, a)
  for (const key of trail) {
    if (node._tag === 'Plan') {
      const edited = editPlan(world.graph, node.plan, key)
      if (edited !== null) {
        node = planNode(world, a, edited)
        continue
      }
    }
    if (node._tag !== 'Menu' && node._tag !== 'Plan') {
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
