import { describe, expect, test } from 'bun:test'

import { cabLayers, eramFeatureVisible, parseVideoMap, strokeRings } from '../src/domain/videomap'

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
    expect(map.eram).toBeNull()
    expect(map.features[0]).toEqual({ asdex: 'runway', color: null, thickness: null, zIndex: null, polygons: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]], lines: [], points: [], text: null, filters: null, bcg: null, style: null })
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

  test('ERAM maps: the defaults feature sets kind, filters, BCG and style; points and text are kept; filter 0 always shows', () => {
    const map = parseVideoMap('e', {
      features: [
        { properties: { isSymbolDefaults: true, bcg: 2, filters: [1, 3], style: 'VOR', size: 1 }, geometry: { type: 'Point', coordinates: [-96.6, 46.6] } },
        { properties: {}, geometry: { type: 'Point', coordinates: [-92.1, 45.8] } },
        { properties: { text: ['D1A'], filters: [0] }, geometry: { type: 'Point', coordinates: [-94.6, 48.6] } },
        { properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
      ],
    })
    expect(map.eram).toEqual({ kind: 'symbol', filters: [1, 3], bcg: 2, style: 'VOR', size: 1, xOffset: 0, yOffset: 0 })
    expect(map.features).toHaveLength(3)
    expect(map.features[0]!.points).toEqual([[-92.1, 45.8]])
    expect(map.features[1]!.text).toEqual(['D1A'])
    expect(eramFeatureVisible(map, map.features[0]!, new Set([3]))).toBe(true)
    expect(eramFeatureVisible(map, map.features[0]!, new Set([2]))).toBe(false)
    expect(eramFeatureVisible(map, map.features[1]!, new Set())).toBe(true)
    // a plain STARS map drops bare points
    expect(parseVideoMap('s', { features: [{ properties: {}, geometry: { type: 'Point', coordinates: [1, 1] } }] }).features).toHaveLength(0)
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
