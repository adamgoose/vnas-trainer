/**
 * Taxiway graph built from a training airport map (docs/REWRITE.md section 5,
 * "Graph"). Vertices within 100 ft merge into one node; edges keep the name of the
 * feature that drew them, runways drawn after taxiways so a shared segment reads as
 * runway. The result is plain data so it can live in the Model.
 */
import { Schema } from 'effect'

import { type AirportMap, LonLat } from './catalog'
import { Projection, bearingDeg, distanceFt, projectionAt } from './geo'

export const MERGE_TOLERANCE_FT = 100

export const Edge = Schema.Struct({ to: Schema.Number, w: Schema.Number, name: Schema.String })
export type Edge = typeof Edge.Type

export const RunwayEnd = Schema.Struct({ runway: Schema.String, chain: Schema.Array(Schema.Number) })
export type RunwayEnd = typeof RunwayEnd.Type

export const Parking = Schema.Struct({
  c: LonLat,
  heading: Schema.Number,
  node: Schema.Number,
  spot: Schema.Boolean,
})
export type Parking = typeof Parking.Type

export const Bounds = Schema.Struct({
  lon0: Schema.Number,
  lon1: Schema.Number,
  lat0: Schema.Number,
  lat1: Schema.Number,
})
export type Bounds = typeof Bounds.Type

export const Graph = Schema.Struct({
  nodes: Schema.Array(LonLat),
  /** adjacency[node] lists the edges leaving that node */
  adjacency: Schema.Array(Schema.Array(Edge)),
  /** runway designator ("30L") to its full runway name and node chain from that threshold */
  runwayEnds: Schema.Record(Schema.String, RunwayEnd),
  /** full runway names ("12R-30L") */
  runwayNames: Schema.Array(Schema.String),
  /** taxiway name to the nodes it touches (runway names excluded) */
  taxiways: Schema.Record(Schema.String, Schema.Array(Schema.Number)),
  /** nodeTaxiways[node] lists the taxiway names through that node */
  nodeTaxiways: Schema.Array(Schema.Array(Schema.String)),
  /** nodeRunways[node] lists the full runway names whose chain includes that node */
  nodeRunways: Schema.Array(Schema.Array(Schema.String)),
  parking: Schema.Record(Schema.String, Parking),
  bounds: Bounds,
  projection: Projection,
})
export type Graph = typeof Graph.Type

export const isRunwayName = (graph: Graph, name: string): boolean => graph.runwayNames.includes(name)

/**
 * The runways the step from node `a` to node `b` enters: runways `b` is on that `a`
 * is not. A taxiway crossing a runway shares one node with it and never traverses a
 * runway-named edge, so this, not the edge name, is what says a runway is being
 * entered. Moving along a runway or leaving it enters nothing.
 */
export const runwaysEntered = (graph: Graph, a: number, b: number): ReadonlyArray<string> => {
  const after = graph.nodeRunways[b] ?? []
  if (after.length === 0) {
    return after
  }
  const before = graph.nodeRunways[a] ?? []
  return before.length === 0 ? after : after.filter((r) => !before.includes(r))
}

export const buildGraph = (map: AirportMap): Graph => {
  const all: Array<LonLat> = [
    ...map.taxi.flatMap((t) => t.c),
    ...map.rwy.flatMap((r) => r.c),
    ...Object.values(map.park).map((p): LonLat => [p[0], p[1]]),
    ...Object.values(map.spot).map((p): LonLat => [p[0], p[1]]),
  ]
  const bounds: Bounds = all.reduce(
    (b, c) => ({
      lon0: Math.min(b.lon0, c[0]),
      lon1: Math.max(b.lon1, c[0]),
      lat0: Math.min(b.lat0, c[1]),
      lat1: Math.max(b.lat1, c[1]),
    }),
    { lon0: Infinity, lon1: -Infinity, lat0: Infinity, lat1: -Infinity },
  )
  const projection = projectionAt((bounds.lat0 + bounds.lat1) / 2)
  const ft = (a: LonLat, b: LonLat) => distanceFt(projection, a, b)

  const nodes: Array<LonLat> = []
  const grid = new Map<string, Array<number>>()
  const cellX = MERGE_TOLERANCE_FT / projection.ftLon
  const cellY = MERGE_TOLERANCE_FT / projection.ftLat
  const nodeFor = (c: LonLat): number => {
    const gx = Math.floor(c[0] / cellX)
    const gy = Math.floor(c[1] / cellY)
    let best: number | null = null
    let bestDistance = MERGE_TOLERANCE_FT
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const i of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          const d = ft(nodes[i]!, c)
          if (d < bestDistance) {
            bestDistance = d
            best = i
          }
        }
      }
    }
    if (best !== null) {
      return best
    }
    nodes.push([c[0], c[1]])
    const key = `${gx},${gy}`
    const bucket = grid.get(key) ?? []
    bucket.push(nodes.length - 1)
    grid.set(key, bucket)
    return nodes.length - 1
  }
  const chainOf = (coords: ReadonlyArray<LonLat>): Array<number> => {
    const chain = coords.map(nodeFor)
    return chain.filter((n, i) => i === 0 || n !== chain[i - 1])
  }

  const edgeNames = new Map<string, string>()
  const addChain = (chain: ReadonlyArray<number>, name: string) => {
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = chain[i]!
      const b = chain[i + 1]!
      edgeNames.set(`${Math.min(a, b)}-${Math.max(a, b)}`, name)
    }
  }
  const taxiwayNodes = new Map<string, Set<number>>()
  for (const t of map.taxi) {
    const chain = chainOf(t.c)
    addChain(chain, t.n)
    const set = taxiwayNodes.get(t.n) ?? new Set<number>()
    chain.forEach((n) => set.add(n))
    taxiwayNodes.set(t.n, set)
  }
  const runwayChains = new Map<string, Array<number>>()
  for (const r of map.rwy) {
    const chain = chainOf(r.c)
    if (chain.length < 2) {
      continue
    }
    runwayChains.set(r.n, chain)
    addChain(chain, r.n)
  }
  const runwayNames = [...runwayChains.keys()]

  const adjacency: Array<Array<Edge>> = nodes.map(() => [])
  for (const [key, name] of edgeNames) {
    const [a, b] = key.split('-').map(Number) as [number, number]
    const w = Math.round(ft(nodes[a]!, nodes[b]!) * 10) / 10
    adjacency[a]!.push({ to: b, w, name })
    adjacency[b]!.push({ to: a, w, name })
  }

  const runwayEnds: Record<string, RunwayEnd> = {}
  for (const [name, chain] of runwayChains) {
    const [first, second] = name.split('-')
    runwayEnds[first!] = { runway: name, chain }
    if (second !== undefined) {
      runwayEnds[second] = { runway: name, chain: [...chain].reverse() }
    }
  }

  const seen = new Set<number>()
  let mainComponent: Array<number> = []
  for (let n = 0; n < nodes.length; n++) {
    if (seen.has(n)) {
      continue
    }
    const component: Array<number> = []
    const stack = [n]
    seen.add(n)
    while (stack.length > 0) {
      const x = stack.pop()!
      component.push(x)
      for (const e of adjacency[x] ?? []) {
        if (!seen.has(e.to)) {
          seen.add(e.to)
          stack.push(e.to)
        }
      }
    }
    if (component.length > mainComponent.length) {
      mainComponent = component
    }
  }
  const attach = (c: LonLat): number =>
    mainComponent.reduce(
      (best, i) => (ft(nodes[i]!, c) < ft(nodes[best]!, c) ? i : best),
      mainComponent[0] ?? 0,
    )
  const parking: Record<string, Parking> = {}
  for (const [name, p] of Object.entries(map.spot)) {
    parking[name] = { c: [p[0], p[1]], heading: p[2], node: attach([p[0], p[1]]), spot: true }
  }
  for (const [name, p] of Object.entries(map.park)) {
    parking[name] = { c: [p[0], p[1]], heading: p[2], node: attach([p[0], p[1]]), spot: false }
  }
  const taxiways: Record<string, Array<number>> = {}
  const nodeTaxiways: Array<Array<string>> = nodes.map(() => [])
  for (const [name, set] of taxiwayNodes) {
    if (!runwayChains.has(name)) {
      taxiways[name] = [...set]
      set.forEach((n) => nodeTaxiways[n]!.push(name))
    }
  }
  const nodeRunways: Array<Array<string>> = nodes.map(() => [])
  for (const [name, chain] of runwayChains) {
    for (const n of chain) {
      if (!nodeRunways[n]!.includes(name)) {
        nodeRunways[n]!.push(name)
      }
    }
  }

  return { nodes, adjacency, runwayEnds, runwayNames, taxiways, nodeTaxiways, nodeRunways, parking, bounds, projection }
}

// QUERIES

export const edgeName = (graph: Graph, a: number, b: number): string | null =>
  graph.adjacency[a]?.find((e) => e.to === b)?.name ?? null

export const nearestNode = (graph: Graph, c: LonLat): number =>
  graph.nodes.reduce(
    (best, n, i) =>
      distanceFt(graph.projection, n, c) < distanceFt(graph.projection, graph.nodes[best]!, c) ? i : best,
    0,
  )

/** The nodes a taxiway name or runway designator covers, or null when unknown. */
export const nodesNamed = (graph: Graph, name: string): ReadonlyArray<number> | null => {
  const taxiway = graph.taxiways[name]
  if (taxiway !== undefined) {
    return taxiway
  }
  const end = graph.runwayEnds[name]
  if (end !== undefined) {
    return end.chain
  }
  const full = Object.values(graph.runwayEnds).find((e) => e.runway === name)
  return full?.chain ?? null
}

export const nearestOn = (graph: Graph, name: string, from: number): number | null =>
  extremeOn(graph, name, from, (d, best) => d < best)

export const farthestOn = (graph: Graph, name: string, from: number): number | null =>
  extremeOn(graph, name, from, (d, best) => d > best)

const extremeOn = (
  graph: Graph,
  name: string,
  from: number,
  better: (d: number, best: number) => boolean,
): number | null => {
  const list = nodesNamed(graph, name)
  if (list === null || list.length === 0) {
    return null
  }
  const origin = graph.nodes[from]!
  return list.reduce<number | null>((best, n) => {
    const d = distanceFt(graph.projection, graph.nodes[n]!, origin)
    if (best === null) {
      return n
    }
    return better(d, distanceFt(graph.projection, graph.nodes[best]!, origin)) ? n : best
  }, null)
}

/** The last non-runway node before entering the runway from this threshold. */
export const holdNodeFor = (graph: Graph, designator: string): number | null => {
  const end = graph.runwayEnds[designator]
  if (end === undefined) {
    return null
  }
  for (const n of end.chain) {
    const exits = (graph.adjacency[n] ?? []).filter((e) => !isRunwayName(graph, e.name))
    const nearest = exits.reduce<Edge | null>((best, e) => (best === null || e.w < best.w ? e : best), null)
    if (nearest !== null) {
      return nearest.to
    }
  }
  return end.chain[0] ?? null
}

/** A taxiway meeting a runway: where an intersection departure enters it. */
export type RunwayEntry = Readonly<{
  taxiway: string
  /** the runway chain node the taxiway meets */
  node: number
  /** index of that node in the chain from the threshold */
  index: number
  /** the taxiway's nodes next to the runway: one, or one on each side where it crosses */
  holds: ReadonlyArray<number>
}>

/**
 * Every taxiway that meets a runway short of its far end, from the threshold on:
 * the entries an intersection departure can use. The full-length entry is the
 * one holding at `holdNodeFor`.
 */
export const runwayEntries = (graph: Graph, designator: string): ReadonlyArray<RunwayEntry> => {
  const end = graph.runwayEnds[designator]
  if (end === undefined) {
    return []
  }
  const out: Array<RunwayEntry> = []
  end.chain.slice(0, -1).forEach((node, index) => {
    const byName = new Map<string, Array<number>>()
    for (const e of graph.adjacency[node] ?? []) {
      if (!isRunwayName(graph, e.name)) {
        byName.set(e.name, [...(byName.get(e.name) ?? []), e.to])
      }
    }
    for (const [taxiway, holds] of byName) {
      if (!out.some((x) => x.taxiway === taxiway)) {
        out.push({ taxiway, node, index, holds })
      }
    }
  })
  return out
}

export type IntersectionHold = Readonly<{ entry: number; hold: number }> | Readonly<{ error: string }>

/**
 * Where an aircraft holds for runway `designator` at taxiway `taxiway`, and the
 * runway node it will enter from there. Where the taxiway crosses the runway the
 * hold nearest `from` is used.
 */
export const holdNodeAt = (graph: Graph, designator: string, taxiway: string, from: LonLat | null): IntersectionHold => {
  const end = graph.runwayEnds[designator]
  if (end === undefined) {
    return { error: `no runway ${designator}` }
  }
  const entry = runwayEntries(graph, designator).find((e) => e.taxiway === taxiway)
  if (entry === undefined) {
    const last = end.chain[end.chain.length - 1]!
    const atFarEnd = (graph.adjacency[last] ?? []).some((e) => e.name === taxiway && !isRunwayName(graph, e.name))
    return { error: atFarEnd ? `no runway left at ${taxiway}` : `${taxiway} does not meet runway ${designator}` }
  }
  const hold =
    from === null
      ? entry.holds[0]!
      : entry.holds.reduce((best, n) => (distanceFt(graph.projection, graph.nodes[n]!, from) < distanceFt(graph.projection, graph.nodes[best]!, from) ? n : best), entry.holds[0]!)
  return { entry: entry.node, hold }
}

/** The hold point of a departure: full length, or the intersection named. */
export const departureHold = (graph: Graph, designator: string, intersection: string | null, from: LonLat | null): IntersectionHold => {
  if (intersection !== null) {
    return holdNodeAt(graph, designator, intersection, from)
  }
  const end = graph.runwayEnds[designator]
  const hold = holdNodeFor(graph, designator)
  if (end === undefined || hold === null) {
    return { error: `no runway ${designator}` }
  }
  const entry = end.chain.find((n) => (graph.adjacency[n] ?? []).some((e) => e.to === hold)) ?? end.chain[0]!
  return { entry, hold }
}

/** True course of a runway from its threshold, or null when unknown. */
export const runwayCourse = (graph: Graph, designator: string): number | null => {
  const end = graph.runwayEnds[designator]
  const [a, b] = end?.chain ?? []
  if (a === undefined || b === undefined) {
    return null
  }
  return bearingDeg(graph.projection, graph.nodes[a]!, graph.nodes[b]!)
}

export const gateNames = (graph: Graph): ReadonlyArray<string> =>
  Object.entries(graph.parking)
    .filter(([, p]) => !p.spot)
    .map(([name]) => name)
