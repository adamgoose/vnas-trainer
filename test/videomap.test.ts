import { describe, expect, test } from 'bun:test'

import { cabLayers, parseVideoMap, strokeRings } from '../src/domain/videomap'

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
    expect(map.features[0]).toEqual({ asdex: 'runway', color: null, thickness: null, zIndex: null, polygons: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]], lines: [] })
    expect(map.features[1]!.polygons).toHaveLength(2)
    expect(map.features[1]!.color).toBe('#123')
    expect(map.features[2]).toMatchObject({ color: '#abc', thickness: 2, lines: [[[0, 0], [5, 5]]] })
    expect(map.features[3]!.lines).toHaveLength(2)
    expect(strokeRings(map)).toHaveLength(6)
  })

  test('tower-cab layers group features by colour, draw order and kind, in draw order', () => {
    const line = (color: string, zIndex: number) => ({ properties: { color, zIndex }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } })
    const fill = (color: string, zIndex: number) => ({ properties: { color, zIndex }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } })
    const map = parseVideoMap('cab', { features: [line('#fcb737', 3), fill('#343434', 1), line('#fcb737', 3), fill('#737373', 0), line('#ffffff', 1)] })
    expect(cabLayers(map)).toEqual([
      { key: 'fill:#737373:0', color: '#737373', zIndex: 0, kind: 'fill', count: 1 },
      { key: 'fill:#343434:1', color: '#343434', zIndex: 1, kind: 'fill', count: 1 },
      { key: 'line:#ffffff:1', color: '#ffffff', zIndex: 1, kind: 'line', count: 1 },
      { key: 'line:#fcb737:3', color: '#fcb737', zIndex: 3, kind: 'line', count: 2 },
    ])
  })

  test('ASDE-X categories are matched regardless of case', () => {
    const map = parseVideoMap('m', {
      features: [
        { properties: { asdex: 'Runway' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
        { properties: { asdex: 'TAXIWAY ' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
      ],
    })
    expect(map.features.map((f) => f.asdex)).toEqual(['runway', 'taxiway'])
  })
})
