/**
 * Routing over the taxiway graph (docs/REWRITE.md section 5, "Routing"). Shortest
 * path with a runway penalty; when the controller named taxiways, edges not on them
 * cost `w * 1.5 + 380` so the named ones are a bias rather than hard waypoints.
 */
import { type Graph, farthestOn, isRunwayName, nodesNamed } from './graph'

export const RUNWAY_PENALTY_FT = 6000
export const PUSHBACK_RUNWAY_PENALTY_FT = 900000
export const UNNAMED_FACTOR = 1.5
export const UNNAMED_FIXED_FT = 380

export type RouteOptions = Readonly<{
  prefer?: ReadonlySet<string> | undefined
  runwayPenalty?: number | undefined
}>

type Heap = Array<readonly [number, number]>
const heapPush = (heap: Heap, item: readonly [number, number]) => {
  heap.push(item)
  let i = heap.length - 1
  while (i > 0) {
    const parent = (i - 1) >> 1
    if (heap[parent]![0] <= heap[i]![0]) {
      break
    }
    ;[heap[parent], heap[i]] = [heap[i]!, heap[parent]!]
    i = parent
  }
}
const heapPop = (heap: Heap): readonly [number, number] | undefined => {
  const top = heap[0]
  const last = heap.pop()
  if (heap.length > 0 && last !== undefined) {
    heap[0] = last
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < heap.length && heap[l]![0] < heap[m]![0]) {
        m = l
      }
      if (r < heap.length && heap[r]![0] < heap[m]![0]) {
        m = r
      }
      if (m === i) {
        break
      }
      ;[heap[m], heap[i]] = [heap[i]!, heap[m]!]
      i = m
    }
  }
  return top
}

/** Node path from `from` to `to` inclusive, or null when unreachable. */
export const findPath = (
  graph: Graph,
  from: number,
  to: number,
  options: RouteOptions = {},
): ReadonlyArray<number> | null => {
  const runwayPenalty = options.runwayPenalty ?? RUNWAY_PENALTY_FT
  const prefer = options.prefer
  const dist = new Array<number>(graph.nodes.length).fill(Infinity)
  const prev = new Array<number>(graph.nodes.length).fill(-1)
  dist[from] = 0
  const heap: Heap = [[0, from]]
  while (heap.length > 0) {
    const [d, n] = heapPop(heap)!
    if (n === to) {
      break
    }
    if (d > dist[n]!) {
      continue
    }
    for (const e of graph.adjacency[n] ?? []) {
      const cost = isRunwayName(graph, e.name)
        ? e.w + runwayPenalty
        : prefer !== undefined && !prefer.has(e.name)
          ? e.w + e.w * UNNAMED_FACTOR + UNNAMED_FIXED_FT
          : e.w
      const nd = d + cost
      if (nd < dist[e.to]!) {
        dist[e.to] = nd
        prev[e.to] = n
        heapPush(heap, [nd, e.to])
      }
    }
  }
  if (dist[to] === Infinity) {
    return null
  }
  const path: Array<number> = []
  for (let n = to; n !== -1; n = prev[n]!) {
    path.push(n)
    if (n === from) {
      break
    }
  }
  return path.reverse()
}

export type RouteResult = Readonly<{ path: ReadonlyArray<number> }> | Readonly<{ error: string }>

/**
 * One shortest path to `finalNode`, or to the farthest node of the last named
 * taxiway when no destination is given, biased toward the named taxiways.
 */
export const routeVia = (
  graph: Graph,
  from: number,
  names: ReadonlyArray<string>,
  finalNode: number | null,
): RouteResult => {
  for (const name of names) {
    if (nodesNamed(graph, name) === null) {
      return { error: `unfamiliar with ${name}` }
    }
  }
  let goal = finalNode
  if (goal === null) {
    const last = names[names.length - 1]
    if (last === undefined) {
      return { error: 'taxi where?' }
    }
    goal = farthestOn(graph, last, from)
    if (goal === null) {
      return { error: `unfamiliar with ${last}` }
    }
  }
  const path = findPath(graph, from, goal, { prefer: new Set(names) })
  if (path === null || path.length < 2) {
    return { error: 'no route from here' }
  }
  return { path }
}
