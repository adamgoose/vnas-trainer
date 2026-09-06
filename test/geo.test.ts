import { describe, expect, test } from 'bun:test'

import { FT_LAT, bearingDeg, distanceFt, headingDiff, movePoint, nmFromCenter, nmOffset, projectionAt, radarProjectionAt, reciprocal, turnDelta } from '../src/domain/geo'

describe('geometry', () => {
  const p = projectionAt(45)

  test('feet per degree of longitude shrinks with latitude', () => {
    expect(p.ftLat).toBe(FT_LAT)
    expect(p.ftLon).toBeCloseTo(FT_LAT * Math.cos(Math.PI / 4), 3)
  })

  test('one degree of latitude is 364000 ft due north', () => {
    expect(distanceFt(p, [0, 45], [0, 46])).toBeCloseTo(364000, 3)
    expect(bearingDeg(p, [0, 45], [0, 46])).toBeCloseTo(0, 6)
    expect(bearingDeg(p, [0, 45], [1, 45])).toBeCloseTo(90, 6)
    expect(bearingDeg(p, [0, 45], [0, 44])).toBeCloseTo(180, 6)
  })

  test('movePoint then distance round-trips', () => {
    const to = movePoint(p, [-93.2, 44.9], 123, 5000)
    expect(distanceFt(p, [-93.2, 44.9], to)).toBeCloseTo(5000, 3)
    expect(bearingDeg(p, [-93.2, 44.9], to)).toBeCloseTo(123, 3)
  })

  test('turn deltas and heading differences wrap', () => {
    expect(turnDelta(350, 10)).toBe(20)
    expect(turnDelta(10, 350)).toBe(-20)
    expect(headingDiff(0, 180)).toBe(180)
    expect(headingDiff(90, 270)).toBe(180)
    expect(reciprocal(300)).toBe(120)
  })

  test('radar uses nautical miles east and south', () => {
    const rp = radarProjectionAt(0)
    expect(nmOffset(rp, [0, 0], [1, 0])).toEqual([60, 0])
    expect(nmOffset(rp, [0, 0], [0, 1])).toEqual([0, -60])
    expect(nmFromCenter(rp, [0, 0], [0.1, 0])).toBeCloseTo(6, 6)
  })
})
