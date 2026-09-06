/**
 * Deterministic PRNG whose state lives in the Model (xorshift32). Every random draw
 * returns the value and the next state, so replaying the message log reproduces a
 * session exactly.
 */
import { Schema } from 'effect'

export const Prng = Schema.Struct({ state: Schema.Number })
export type Prng = typeof Prng.Type

export const seedPrng = (seed: number): Prng => ({ state: seed >>> 0 || 0x9e3779b9 })

/** Uniform in [0, 1). */
export const nextUnit = (p: Prng): readonly [number, Prng] => {
  let x = p.state
  x ^= x << 13
  x >>>= 0
  x ^= x >>> 17
  x ^= x << 5
  x >>>= 0
  return [x / 4294967296, { state: x }]
}

/** Integer in [0, n). */
export const nextInt = (p: Prng, n: number): readonly [number, Prng] => {
  const [u, next] = nextUnit(p)
  return [Math.floor(u * n), next]
}

/** Uniform in [lo, hi). */
export const nextBetween = (p: Prng, lo: number, hi: number): readonly [number, Prng] => {
  const [u, next] = nextUnit(p)
  return [lo + u * (hi - lo), next]
}

export const pick = <A>(p: Prng, items: ReadonlyArray<A>): readonly [A | undefined, Prng] => {
  const [i, next] = nextInt(p, items.length)
  return [items[i], next]
}

/** Index chosen with probability proportional to `weight`. */
export const pickWeighted = <A>(p: Prng, items: ReadonlyArray<A>, weight: (a: A) => number): readonly [A | undefined, Prng] => {
  const total = items.reduce((s, a) => s + weight(a), 0)
  const [r, next] = nextBetween(p, 0, total)
  let remaining = r
  for (const a of items) {
    remaining -= weight(a)
    if (remaining <= 0) {
      return [a, next]
    }
  }
  return [items[0], next]
}
