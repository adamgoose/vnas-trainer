/**
 * A taxi clearance to a departure runway proposed on the scope (pure): the runway,
 * intersections the route should pass through, and runway crossings cleared up
 * front. A plan is a command line the parser accepts; its preview is that line
 * executed on the world, so what the scope draws is exactly what GO will issue.
 * Intersections do not appear in the line: the route through them names the
 * taxiways it uses, and the executor prefers those.
 */
import type { Aircraft } from '../domain/aircraft'
import { executeCommand, parseCommandLine } from '../domain/commands'
import { type Graph, edgeName, holdNodeFor, isRunwayName, nearestNode, runwaysEntered } from '../domain/graph'
import { findPath } from '../domain/route'
import { type World, findAircraft } from '../domain/world'

export type RoutePlan = Readonly<{
  runway: string
  /** graph nodes the route passes through, in the order clicked */
  waypoints: ReadonlyArray<number>
  /** full runway names cleared to cross with the clearance */
  cross: ReadonlyArray<string>
}>

/** A runway the previewed route enters: the aircraft holds at `node` unless the crossing is cleared. */
export type Crossing = Readonly<{ leg: number; node: number; runway: string; cleared: boolean }>

export type PlanPreview = Readonly<{
  line: string
  path: ReadonlyArray<number> | null
  crossings: ReadonlyArray<Crossing>
  error: string | null
}>

export const newPlan = (runway: string): RoutePlan => ({ runway, waypoints: [], cross: [] })

export const toggleWaypoint = (plan: RoutePlan, node: number): RoutePlan => ({
  ...plan,
  waypoints: plan.waypoints.includes(node) ? plan.waypoints.filter((n) => n !== node) : [...plan.waypoints, node],
})

export const toggleCross = (plan: RoutePlan, runway: string): RoutePlan => ({
  ...plan,
  cross: plan.cross.includes(runway) ? plan.cross.filter((r) => r !== runway) : [...plan.cross, runway],
})

/** Where a taxi starts: the gate's node when parked, else the nearest node. */
const startNode = (graph: Graph, a: Aircraft): number => {
  const home = a.gate !== null ? graph.parking[a.gate] : undefined
  return a.state === 'PARKED' && home !== undefined ? home.node : nearestNode(graph, a.position)
}

/** One path from `from` through every waypoint to `to`, or null when some leg is unreachable. */
const throughPath = (graph: Graph, from: number, waypoints: ReadonlyArray<number>, to: number, cleared: ReadonlyArray<string>): ReadonlyArray<number> | null => {
  const out: Array<number> = [from]
  let at = from
  for (const next of [...waypoints, to]) {
    if (next === at) {
      continue
    }
    const leg = findPath(graph, at, next, { cleared })
    if (leg === null) {
      return null
    }
    out.push(...leg.slice(1))
    at = next
  }
  return out
}

/** The taxiways a path runs along, in order of first use; runways are left out (naming one clears it). */
export const routeNames = (graph: Graph, path: ReadonlyArray<number>): ReadonlyArray<string> => {
  const names: Array<string> = []
  for (let i = 0; i + 1 < path.length; i++) {
    const name = edgeName(graph, path[i]!, path[i + 1]!)
    if (name !== null && !isRunwayName(graph, name) && !names.includes(name)) {
      names.push(name)
    }
  }
  return names
}

/** The command line the plan stands for: `RWY 30L [TAXI twy…] [CROSS rwy…]`. */
export const planLine = (graph: Graph, a: Aircraft, plan: RoutePlan): string => {
  const hold = holdNodeFor(graph, plan.runway)
  const path = plan.waypoints.length === 0 || hold === null ? null : throughPath(graph, startNode(graph, a), plan.waypoints, hold, plan.cross)
  const names = path === null ? [] : routeNames(graph, path)
  return ['RWY', plan.runway, ...(names.length > 0 ? ['TAXI', ...names] : []), ...(plan.cross.length > 0 ? ['CROSS', ...plan.cross] : [])].join(' ')
}

/** Every runway a path enters, with whether the aircraft may cross it without stopping. */
export const crossingsOf = (graph: Graph, path: ReadonlyArray<number>, cleared: ReadonlyArray<string>): ReadonlyArray<Crossing> => {
  const out: Array<Crossing> = []
  for (let i = 0; i + 1 < path.length; i++) {
    for (const runway of runwaysEntered(graph, path[i]!, path[i + 1]!)) {
      out.push({ leg: i, node: path[i]!, runway, cleared: cleared.includes(runway) })
    }
  }
  return out
}

let lastPreview: Readonly<{ graph: Graph; callsign: string; start: number; key: string; preview: PlanPreview }> | null = null

/** The plan's line executed on the world: the route the aircraft would follow and where it would hold. Memoised for the last plan asked about. */
export const planPreview = (world: World, a: Aircraft, plan: RoutePlan): PlanPreview => {
  const graph = world.graph
  const start = startNode(graph, a)
  const key = JSON.stringify(plan)
  if (lastPreview !== null && lastPreview.graph === graph && lastPreview.callsign === a.callsign && lastPreview.start === start && lastPreview.key === key) {
    return lastPreview.preview
  }
  const line = planLine(graph, a, plan)
  const preview = ((): PlanPreview => {
    const parsed = parseCommandLine(world, null, `${a.callsign} ${line}`)
    if (parsed._tag !== 'Parsed') {
      return { line, path: null, crossings: [], error: parsed._tag === 'Invalid' ? parsed.error : 'not a command' }
    }
    const out = executeCommand(world, parsed.callsign, parsed.command)
    if ('error' in out) {
      return { line, path: null, crossings: [], error: out.error }
    }
    const next = findAircraft(out.world, a.callsign)
    if (next === undefined || next.path === null) {
      return { line, path: null, crossings: [], error: 'no route' }
    }
    return { line, path: next.path, crossings: crossingsOf(graph, next.path, next.cleared), error: null }
  })()
  lastPreview = { graph, callsign: a.callsign, start, key, preview }
  return preview
}

const intersectionCache = new WeakMap<Graph, ReadonlyArray<number>>()

/** Nodes where two or more taxiways meet, off the runways: the points a route can be sent through. */
export const intersections = (graph: Graph): ReadonlyArray<number> => {
  const cached = intersectionCache.get(graph)
  if (cached !== undefined) {
    return cached
  }
  const out: Array<number> = []
  graph.nodeTaxiways.forEach((names, n) => {
    if (names.length >= 2 && (graph.nodeRunways[n] ?? []).length === 0) {
      out.push(n)
    }
  })
  intersectionCache.set(graph, out)
  return out
}
