/**
 * vNAS NavData.dat (docs/REWRITE.md Phase 8): a protobuf with no published
 * schema, decoded straight off the wire format. Top-level repeated fields:
 * 1 airports, 2 fixes and navaids, 3 airways, 4 SIDs, 5 STARs. Pure; used by
 * the catalog builder under Bun and by live mode in the browser.
 */
import type { LonLat } from './catalog'
import { FT_PER_NM, movePoint, nmFromCenter, projectionAt, radarProjectionAt } from './geo'

export type NavAirport = Readonly<{ id: string; icao: string; artcc: string; name: string; elevation: number; c: LonLat }>

/** A SID or STAR: `transitions` are the branches, `common` the shared part (after them for a STAR, before them for a SID). */
export type Procedure = Readonly<{ id: string; transitions: ReadonlyArray<ReadonlyArray<string>>; common: ReadonlyArray<string> }>

export type NavData = Readonly<{
  airports: ReadonlyMap<string, NavAirport>
  fixes: ReadonlyMap<string, LonLat>
  airways: ReadonlyMap<string, ReadonlyArray<string>>
  sids: ReadonlyArray<Procedure & Readonly<{ airport: string | null }>>
  stars: ReadonlyArray<Procedure>
}>

/** The subset baked into an airport file (src/domain/catalog.ts `AirportNav`). */
export type AirportNav = Readonly<{
  fixes: Readonly<Record<string, LonLat>>
  stars: Readonly<Record<string, Procedure>>
  sids: Readonly<Record<string, Procedure>>
}>

export const emptyNav: AirportNav = { fixes: {}, stars: {}, sids: {} }

// WIRE FORMAT

type Field = Readonly<{ number: number; wire: number; varint: number; bytes: Uint8Array }>

const utf8 = new TextDecoder()

/** Every field of one message, in order. Unknown wire types end the message. */
export const fieldsOf = (bytes: Uint8Array): ReadonlyArray<Field> => {
  const out: Array<Field> = []
  let pos = 0
  const varint = (): number => {
    let x = 0
    let mult = 1
    for (;;) {
      const b = bytes[pos++]
      if (b === undefined) {
        return x
      }
      x += (b & 0x7f) * mult
      if ((b & 0x80) === 0) {
        return x
      }
      mult *= 128
    }
  }
  while (pos < bytes.length) {
    const key = varint()
    const number = Math.floor(key / 8)
    const wire = key % 8
    if (wire === 0) {
      out.push({ number, wire, varint: varint(), bytes: new Uint8Array(0) })
    } else if (wire === 1) {
      out.push({ number, wire, varint: 0, bytes: bytes.subarray(pos, pos + 8) })
      pos += 8
    } else if (wire === 2) {
      const len = varint()
      out.push({ number, wire, varint: 0, bytes: bytes.subarray(pos, pos + len) })
      pos += len
    } else if (wire === 5) {
      out.push({ number, wire, varint: 0, bytes: bytes.subarray(pos, pos + 4) })
      pos += 4
    } else {
      break
    }
  }
  return out
}

const asDouble = (f: Field): number =>
  f.wire === 1 ? new DataView(f.bytes.buffer, f.bytes.byteOffset, 8).getFloat64(0, true) : f.wire === 5 ? new DataView(f.bytes.buffer, f.bytes.byteOffset, 4).getFloat32(0, true) : f.varint
const asString = (f: Field): string => utf8.decode(f.bytes)
const strings = (fields: ReadonlyArray<Field>, number: number): Array<string> => fields.filter((f) => f.number === number && f.wire === 2).map(asString)
const first = (fields: ReadonlyArray<Field>, number: number): Field | undefined => fields.find((f) => f.number === number)

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6

/** `{1: lat, 2: lon}` -> [lon, lat], or null when either is missing. */
const lonLat = (f: Field | undefined): LonLat | null => {
  if (f === undefined || f.wire !== 2) {
    return null
  }
  const fields = fieldsOf(f.bytes)
  const lat = first(fields, 1)
  const lon = first(fields, 2)
  return lat === undefined || lon === undefined ? null : [r6(asDouble(lon)), r6(asDouble(lat))]
}

/** A list message whose repeated field 1 holds fix names. */
const fixList = (f: Field): ReadonlyArray<string> => strings(fieldsOf(f.bytes), 1)

/** MUSCL4 -> MUSCL: procedure names without the revision digit, the key scenarios are matched by. */
export const procedureBase = (id: string): string => id.replace(/\d$/, '')

export const decodeNavData = (bytes: Uint8Array): NavData => {
  const airports = new Map<string, NavAirport>()
  const fixes = new Map<string, LonLat>()
  const airways = new Map<string, ReadonlyArray<string>>()
  const sids: Array<Procedure & Readonly<{ airport: string | null }>> = []
  const stars: Array<Procedure> = []
  for (const record of fieldsOf(bytes)) {
    if (record.wire !== 2) {
      continue
    }
    const fields = fieldsOf(record.bytes)
    const id = strings(fields, 1)[0] ?? ''
    if (id === '') {
      continue
    }
    if (record.number === 1) {
      const c = lonLat(first(fields, 6))
      if (c !== null) {
        const elevation = first(fields, 5)
        airports.set(id, { id, icao: strings(fields, 2)[0] ?? id, artcc: strings(fields, 3)[0] ?? '', name: strings(fields, 4)[0] ?? id, elevation: elevation === undefined ? 0 : asDouble(elevation), c })
      }
    } else if (record.number === 2) {
      const c = lonLat(first(fields, 2))
      if (c !== null && !fixes.has(id)) {
        fixes.set(id, c)
      }
    } else if (record.number === 3) {
      airways.set(id, strings(fields, 2))
    } else if (record.number === 4) {
      const [airport, ...common] = strings(fields, 2)
      sids.push({ id, airport: airport ?? null, common, transitions: fields.filter((f) => f.number === 3 && f.wire === 2).map(fixList) })
    } else if (record.number === 5) {
      stars.push({ id, transitions: fields.filter((f) => f.number === 2 && f.wire === 2).map(fixList), common: strings(fields, 3) })
    }
  }
  return { airports, fixes, airways, sids, stars }
}

// PER-AIRPORT SUBSET

export const NAV_MARGIN_NM = 20

/**
 * The fixes within `rangeNm` of `center`, airports in range as fixes too (FAA and
 * ICAO ids, fixes win a name clash), and every procedure with a fix inside.
 */
export const navForAirport = (nav: NavData, center: LonLat, rangeNm: number): AirportNav => {
  const rp = radarProjectionAt(center[1])
  const inside = (c: LonLat): boolean => nmFromCenter(rp, center, c) <= rangeNm
  const fixes: Record<string, LonLat> = {}
  for (const [name, c] of nav.fixes) {
    if (inside(c)) {
      fixes[name] = c
    }
  }
  for (const a of nav.airports.values()) {
    if (inside(a.c)) {
      fixes[a.id] ??= a.c
      fixes[a.icao] ??= a.c
    }
  }
  const touches = (p: Procedure): boolean => [...p.common, ...p.transitions.flat()].some((f) => fixes[f] !== undefined)
  const stars: Record<string, Procedure> = {}
  for (const p of nav.stars) {
    if (touches(p)) {
      stars[procedureBase(p.id)] = { id: p.id, transitions: p.transitions, common: p.common }
    }
  }
  const sids: Record<string, Procedure> = {}
  for (const p of nav.sids) {
    if (touches(p)) {
      sids[procedureBase(p.id)] = { id: p.id, transitions: p.transitions, common: p.common }
    }
  }
  return { fixes, stars, sids }
}

// LOOKUPS

/** A fix name, or a fix-radial-distance like BITLR120015 (radial 120, 15 nm), to a position. */
export const resolveFixOrFrd = (fixes: ReadonlyMap<string, LonLat> | Readonly<Record<string, LonLat>>, text: string): LonLat | null => {
  const get = (name: string): LonLat | undefined =>
    fixes instanceof Map ? (fixes as ReadonlyMap<string, LonLat>).get(name) : (fixes as Readonly<Record<string, LonLat>>)[name]
  const t = text.trim().toUpperCase()
  const direct = get(t)
  if (direct !== undefined) {
    return direct
  }
  const m = /^([A-Z0-9]{2,5})(\d{3})(\d{3})$/.exec(t)
  if (m === null) {
    return null
  }
  const fix = get(m[1]!)
  if (fix === undefined) {
    return null
  }
  const c = movePoint(projectionAt(fix[1]), fix, parseInt(m[2]!, 10), parseInt(m[3]!, 10) * FT_PER_NM)
  return [r6(c[0]), r6(c[1])]
}

const dedupe = (names: ReadonlyArray<string>): Array<string> => names.filter((n, i) => i === 0 || names[i - 1] !== n)

export type ExpandedPath = Readonly<{
  /** fixes to fly, in order, every one known */
  fixes: ReadonlyArray<string>
  runway: string | null
  /** the STAR or SID matched, by its NavData name */
  procedure: string | null
}>

/**
 * A scenario `navigationPath` ("MUSCL3.30R", "BITLR GEP KANE", "ZMBRO7") to the
 * fixes to fly. A STAR takes the transition whose first fix is nearest `from`
 * then the common route; a SID takes the common route then the transition
 * nearest its end. Unknown tokens (airways, fixes outside the area) are skipped.
 */
export const expandNavigationPath = (nav: AirportNav, path: string, from: LonLat): ExpandedPath => {
  const rp = radarProjectionAt(from[1])
  const known = (name: string): boolean => nav.fixes[name] !== undefined
  const nearest = (branches: ReadonlyArray<ReadonlyArray<string>>, at: LonLat): ReadonlyArray<string> => {
    let best: ReadonlyArray<string> = []
    let bestNm = Infinity
    for (const b of branches) {
      const head = b[0]
      const c = head === undefined ? undefined : nav.fixes[head]
      const d = c === undefined ? Infinity : nmFromCenter(rp, at, c)
      if (d < bestNm) {
        bestNm = d
        best = b
      }
    }
    return best
  }
  const fixes: Array<string> = []
  let runway: string | null = null
  let procedure: string | null = null
  for (const raw of path.trim().toUpperCase().split(/\s+/)) {
    const [token, suffix] = raw.split('.') as [string, string | undefined]
    if (token === '') {
      continue
    }
    if (known(token)) {
      fixes.push(token)
      continue
    }
    const base = procedureBase(token)
    const star = /\d$/.test(token) ? nav.stars[base] : undefined
    const sid = /\d$/.test(token) ? nav.sids[base] : undefined
    if (star !== undefined) {
      procedure = star.id
      fixes.push(...nearest(star.transitions, from), ...star.common)
      if (suffix !== undefined && /^\d{1,2}[LRC]?$/.test(suffix)) {
        runway = suffix
      }
    } else if (sid !== undefined) {
      procedure = sid.id
      const common = sid.common
      const last = common[common.length - 1]
      const end = last === undefined ? from : (nav.fixes[last] ?? from)
      const transition = suffix !== undefined ? (sid.transitions.find((t) => t[t.length - 1] === suffix) ?? nearest(sid.transitions, end)) : nearest(sid.transitions, end)
      fixes.push(...common, ...transition)
    }
  }
  return { fixes: dedupe(fixes).filter(known), runway, procedure }
}
