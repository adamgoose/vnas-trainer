import { describe, expect, test } from 'bun:test'

import { bearingDeg, distanceFt, headingDiff } from '../src/domain/geo'
import { buildGraph, edgeName, farthestOn, gateNames, holdNodeFor, isRunwayName, nearestNode, nearestOn, nodesNamed, runwayCourse } from '../src/domain/graph'
import { msp } from './helpers'

describe('MSP graph', () => {
  const graph = buildGraph(msp.map)

  test('decodes through the catalog schema', () => {
    expect(msp.id).toBe('MSP')
    expect(msp.stars?.twr?.radio).toBe('Minneapolis Tower')
  })

  test('has every runway end as a node chain', () => {
    expect(Object.keys(graph.runwayEnds).sort()).toEqual(['12L', '12R', '17', '22', '30L', '30R', '35', '4'])
    expect(graph.runwayEnds['12R']!.chain).toEqual([...graph.runwayEnds['30L']!.chain].reverse())
    expect(graph.runwayNames).toContain('12R-30L')
  })

  test('merges vertices within 100 ft into one node', () => {
    for (let i = 0; i < graph.nodes.length; i++) {
      for (let j = i + 1; j < graph.nodes.length; j++) {
        expect(distanceFt(graph.projection, graph.nodes[i]!, graph.nodes[j]!)).toBeGreaterThanOrEqual(100 * 0.5)
      }
    }
    expect(graph.nodes.length).toBeLessThan(msp.map.taxi.reduce((n, t) => n + t.c.length, 0))
  })

  test('excludes runway names from taxiways and attaches every gate', () => {
    expect(Object.keys(graph.taxiways)).not.toContain('12R-30L')
    expect(Object.keys(graph.parking)).toHaveLength(220)
    expect(graph.parking['G16']!.node).toBeGreaterThanOrEqual(0)
    expect(gateNames(graph)).toHaveLength(220)
    expect(graph.nodeTaxiways[graph.parking['E16']!.node]).toContain('D')
  })

  test('runway edges win over taxiway edges on shared segments', () => {
    const chain = graph.runwayEnds['30L']!.chain
    for (let i = 0; i + 1 < chain.length; i++) {
      expect(isRunwayName(graph, edgeName(graph, chain[i]!, chain[i + 1]!)!)).toBe(true)
    }
  })

  test('hold node is the first non-runway neighbour walking from the threshold', () => {
    for (const designator of Object.keys(graph.runwayEnds)) {
      const hold = holdNodeFor(graph, designator)!
      const chain = graph.runwayEnds[designator]!.chain
      expect(chain).not.toContain(hold)
      const touches = chain.some((n) => graph.adjacency[n]!.some((e) => e.to === hold && !isRunwayName(graph, e.name)))
      expect(touches).toBe(true)
    }
    expect(graph.nodeTaxiways[holdNodeFor(graph, '30L')!]).toContain('A')
    expect(holdNodeFor(graph, '99')).toBeNull()
  })

  test('runway course follows the chain from the threshold', () => {
    const c30L = runwayCourse(graph, '30L')!
    const c12R = runwayCourse(graph, '12R')!
    expect(Math.abs(c30L - 300)).toBeLessThan(15)
    expect(Math.abs(headingDiff(c12R, c30L) - 180)).toBeLessThan(2)
    expect(runwayCourse(graph, '99')).toBeNull()
  })

  test('name lookups cover taxiways, designators and full runway names', () => {
    expect(nodesNamed(graph, 'A')).toEqual(graph.taxiways['A']!)
    expect(nodesNamed(graph, '30L')).toEqual(graph.runwayEnds['30L']!.chain)
    expect(nodesNamed(graph, '12R-30L')).toEqual(graph.runwayEnds['12R']!.chain)
    expect(nodesNamed(graph, 'ZZ')).toBeNull()
  })

  test('nearest and farthest nodes on a taxiway measure from the origin', () => {
    const from = graph.parking['E16']!.node
    const near = nearestOn(graph, 'A', from)!
    const far = farthestOn(graph, 'A', from)!
    const d = (n: number) => distanceFt(graph.projection, graph.nodes[n]!, graph.nodes[from]!)
    expect(d(near)).toBeLessThan(d(far))
    expect(graph.taxiways['A']).toContain(near)
    expect(nearestNode(graph, graph.nodes[far]!)).toBe(far)
    expect(nearestOn(graph, 'ZZ', from)).toBeNull()
  })

  test('bearing helper agrees with the projection', () => {
    const [a, b] = graph.runwayEnds['4']!.chain
    expect(Math.abs(bearingDeg(graph.projection, graph.nodes[a!]!, graph.nodes[b!]!) - 40)).toBeLessThan(15)
  })
})
