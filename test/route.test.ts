import { describe, expect, test } from 'bun:test'

import { buildGraph, edgeName, holdNodeFor, isRunwayName, nearestOn, runwaysEntered } from '../src/domain/graph'
import { PUSHBACK_RUNWAY_PENALTY_FT, findPath, routeVia } from '../src/domain/route'
import { msp } from './helpers'

describe('routing', () => {
  const graph = buildGraph(msp.map)
  const e16 = graph.parking['E16']!.node
  const legs = (path: ReadonlyArray<number>) => path.slice(0, -1).map((n, i) => edgeName(graph, n, path[i + 1]!)!)
  const entered = (path: ReadonlyArray<number>) => path.slice(0, -1).flatMap((n, i) => runwaysEntered(graph, n, path[i + 1]!))
  const crossesRunway = (path: ReadonlyArray<number>) => legs(path).some((n) => isRunwayName(graph, n)) || entered(path).length > 0

  test('finds a path that starts and ends where asked', () => {
    const hold = holdNodeFor(graph, '30L')!
    const path = findPath(graph, e16, hold)!
    expect(path[0]).toBe(e16)
    expect(path[path.length - 1]).toBe(hold)
    expect(findPath(graph, e16, e16)).toEqual([e16])
  })

  test('the runway penalty keeps taxi routes off the runways', () => {
    const hold30R = holdNodeFor(graph, '30R')!
    const withPenalty = findPath(graph, e16, hold30R)!
    const free = findPath(graph, e16, hold30R, { runwayPenalty: 0 })!
    expect(crossesRunway(withPenalty)).toBe(false)
    expect(free.length).toBeLessThanOrEqual(withPenalty.length)
  })

  /** A taxiway crossing a runway shares a node with it and no runway edge; the penalty applies to that step too. */
  test('the penalty counts a crossing through a shared node, so a route to 30L no longer crosses 30L', () => {
    const hold30L = holdNodeFor(graph, '30L')!
    const viaD = { prefer: new Set(['D']) }
    expect(entered(findPath(graph, e16, hold30L, viaD)!)).toEqual([])
    expect(entered(findPath(graph, e16, hold30L, { ...viaD, runwayPenalty: 0 })!)).toEqual(['12R-30L'])
  })

  test('a cleared runway may be entered without the penalty, but not taxied along', () => {
    const hold17 = holdNodeFor(graph, '17')!
    const plain = findPath(graph, e16, hold17)!
    expect([...entered(plain)].sort()).toEqual(['12R-30L', '4-22'])
    const cleared = findPath(graph, e16, hold17, { cleared: ['4-22', '12R-30L'] })!
    expect([...entered(cleared)].sort()).toEqual(['12R-30L', '4-22'])
    expect(legs(cleared).some((n) => isRunwayName(graph, n))).toBe(false)
    expect(cleared.length).toBeLessThanOrEqual(plain.length)
  })

  test('naming taxiways biases the route onto them', () => {
    const hold = holdNodeFor(graph, '30L')!
    const plain = findPath(graph, e16, hold)!
    const viaC = findPath(graph, e16, hold, { prefer: new Set(['C', 'A']) })!
    const onC = (p: ReadonlyArray<number>) => legs(p).filter((n) => n === 'C').length
    expect(onC(viaC)).toBeGreaterThanOrEqual(onC(plain))
    expect(legs(viaC)).toContain('C')
  })

  test('routeVia ends at the farthest node of the last taxiway when no destination is given', () => {
    const r = routeVia(graph, e16, ['A'], null)
    expect('path' in r).toBe(true)
    if ('path' in r) {
      expect(graph.taxiways['A']).toContain(r.path[r.path.length - 1]!)
    }
  })

  test('routeVia reports unknown names and empty requests', () => {
    expect(routeVia(graph, e16, ['ZZ'], null)).toEqual({ error: 'unfamiliar with ZZ' })
    expect(routeVia(graph, e16, [], null)).toEqual({ error: 'taxi where?' })
    expect(routeVia(graph, e16, ['12R-30L'], null)).not.toHaveProperty('error')
  })

  test('a pushback penalty of 9e5 never crosses a runway', () => {
    for (const gate of ['E16', 'G16', 'A2']) {
      const node = graph.parking[gate]!.node
      const p = findPath(graph, node, nearestOn(graph, 'A', node)!, { runwayPenalty: PUSHBACK_RUNWAY_PENALTY_FT })!
      expect(crossesRunway(p)).toBe(false)
    }
  })
})
