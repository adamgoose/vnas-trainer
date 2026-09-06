import { describe, expect, test } from 'bun:test'

import { nextBetween, nextInt, nextUnit, pick, pickWeighted, seedPrng } from '../src/domain/prng'

describe('prng', () => {
  test('is deterministic for a seed and never repeats state trivially', () => {
    const a = Array.from({ length: 5 }, ((p) => () => {
      const [v, n] = nextUnit(p)
      p = n
      return v
    })(seedPrng(42)))
    const b = Array.from({ length: 5 }, ((p) => () => {
      const [v, n] = nextUnit(p)
      p = n
      return v
    })(seedPrng(42)))
    expect(a).toEqual(b)
    expect(new Set(a).size).toBe(5)
  })

  test('seed 0 still produces a live generator', () => {
    const [v] = nextUnit(seedPrng(0))
    expect(v).toBeGreaterThan(0)
  })

  test('draws stay in range', () => {
    let p = seedPrng(7)
    for (let i = 0; i < 1000; i++) {
      const [u, p1] = nextUnit(p)
      const [n, p2] = nextInt(p1, 6)
      const [b, p3] = nextBetween(p2, 70, 110)
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThan(1)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThan(6)
      expect(b).toBeGreaterThanOrEqual(70)
      expect(b).toBeLessThan(110)
      p = p3
    }
  })

  test('weighted pick follows the weights', () => {
    let p = seedPrng(3)
    const counts = { a: 0, b: 0 }
    for (let i = 0; i < 2000; i++) {
      const [x, next] = pickWeighted(p, ['a', 'b'] as const, (k) => (k === 'a' ? 3 : 1))
      counts[x!]++
      p = next
    }
    expect(counts.a / counts.b).toBeGreaterThan(2)
    expect(counts.a / counts.b).toBeLessThan(4)
    expect(pick(p, [])[0]).toBeUndefined()
  })
})
