import { describe, expect, test } from 'bun:test'

import { parseVideoMap, strokeRings } from '../src/domain/videomap'

describe('video maps', () => {
  test('keeps polygons, multipolygons, lines and multilines with their properties', () => {
    const map = parseVideoMap('m', {
      features: [
        { properties: { asdex: 'runway' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
        { properties: { asdex: 'apron', color: '#123' }, geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [0, 1]]], [[[2, 2], [3, 2], [2, 3]]]] } },
        { properties: { color: '#abc', thickness: 2 }, geometry: { type: 'LineString', coordinates: [[0, 0], [5, 5]] } },
        { properties: {}, geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] } },
        { properties: {}, geometry: { type: 'Point', coordinates: [1, 1] } },
        { properties: {}, geometry: { type: 'LineString', coordinates: [[0, 'x']] } },
        { properties: {}, geometry: null },
      ],
    })
    expect(map.id).toBe('m')
    expect(map.features).toHaveLength(4)
    expect(map.features[0]).toEqual({ asdex: 'runway', color: null, thickness: null, polygons: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]], lines: [] })
    expect(map.features[1]!.polygons).toHaveLength(2)
    expect(map.features[1]!.color).toBe('#123')
    expect(map.features[2]).toMatchObject({ color: '#abc', thickness: 2, lines: [[[0, 0], [5, 5]]] })
    expect(map.features[3]!.lines).toHaveLength(2)
    expect(strokeRings(map)).toHaveLength(6)
  })
})
