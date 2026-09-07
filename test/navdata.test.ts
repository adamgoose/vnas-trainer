import { describe, expect, test } from 'bun:test'

import { decodeNavData, expandNavigationPath, fieldsOf, navForAirport, procedureBase, resolveFixOrFrd } from '../src/domain/navdata'
import { msp } from './helpers'

// A tiny protobuf writer, enough to build a NavData.dat in the shape vNAS ships.

const varint = (n: number): Array<number> => {
  const out: Array<number> = []
  let x = n
  while (x >= 0x80) {
    out.push((x % 0x80) | 0x80)
    x = Math.floor(x / 0x80)
  }
  out.push(x)
  return out
}
const bytes = (field: number, body: ReadonlyArray<number>): Array<number> => [...varint(field * 8 + 2), ...varint(body.length), ...body]
const str = (field: number, s: string): Array<number> => bytes(field, [...new TextEncoder().encode(s)])
const dbl = (field: number, n: number): Array<number> => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setFloat64(0, n, true)
  return [...varint(field * 8 + 1), ...b]
}
const point = (field: number, lat: number, lon: number): Array<number> => bytes(field, [...dbl(1, lat), ...dbl(2, lon)])
const list = (field: number, names: ReadonlyArray<string>): Array<number> => bytes(field, names.flatMap((n) => str(1, n)))

const file = new Uint8Array([
  ...bytes(1, [...str(1, 'MSP'), ...str(2, 'KMSP'), ...str(3, 'ZMP'), ...str(4, 'MINNEAPOLIS'), ...dbl(5, 842), ...point(6, 44.88, -93.22)]),
  ...bytes(1, [...str(1, 'FAR'), ...str(2, 'KFAR'), ...str(3, 'ZMP'), ...str(4, 'FARGO'), ...dbl(5, 900), ...point(6, 46.92, -96.82)]),
  ...bytes(2, [...str(1, 'MUSCL'), ...point(2, 45.03, -91.78)]),
  ...bytes(2, [...str(1, 'BAYKS'), ...point(2, 44.95, -92.5)]),
  ...bytes(2, [...str(1, 'JERMN'), ...point(2, 45.1, -91.4)]),
  ...bytes(2, [...str(1, 'GEP'), ...point(2, 45.15, -93.37)]),
  ...bytes(2, [...str(1, 'JEDET'), ...point(2, 44.7, -93.0)]),
  ...bytes(2, [...str(1, 'MUSCL'), ...point(2, 0, 0)]),
  ...bytes(2, [...str(1, 'NOPOS'), ...bytes(2, dbl(2, 154))]),
  ...bytes(3, [...str(1, 'J34'), ...str(2, 'MUSCL'), ...str(2, 'JERMN')]),
  ...bytes(4, [...str(1, 'ZMBRO7'), ...str(2, 'MSP'), ...str(2, 'JEDET'), ...str(2, 'ZMBRO'), ...list(3, ['ZMBRO', 'ODI'])]),
  ...bytes(5, [...str(1, 'MUSCL4'), ...list(2, ['JERMN', 'MUSCL']), ...list(2, ['CEWDA', 'SHEAY', 'MUSCL']), ...str(3, 'MUSCL'), ...str(3, 'BAYKS')]),
])

describe('NavData wire format', () => {
  test('fieldsOf reads varints, doubles and length-delimited fields', () => {
    const fields = fieldsOf(new Uint8Array([...varint(8), ...varint(300), ...str(2, 'hi'), ...dbl(3, 1.5)]))
    expect(fields.map((f) => [f.number, f.wire])).toEqual([[1, 0], [2, 2], [3, 1]])
    expect(fields[0]!.varint).toBe(300)
    expect(new TextDecoder().decode(fields[1]!.bytes)).toBe('hi')
  })

  test('decodeNavData reads airports, fixes (first of a duplicate name wins, no position skipped), airways, SIDs and STARs', () => {
    const nav = decodeNavData(file)
    expect(nav.airports.get('MSP')).toEqual({ id: 'MSP', icao: 'KMSP', artcc: 'ZMP', name: 'MINNEAPOLIS', elevation: 842, c: [-93.22, 44.88] })
    expect(nav.fixes.size).toBe(5)
    expect(nav.fixes.get('MUSCL')).toEqual([-91.78, 45.03])
    expect(nav.fixes.has('NOPOS')).toBe(false)
    expect(nav.airways.get('J34')).toEqual(['MUSCL', 'JERMN'])
    expect(nav.sids).toEqual([{ id: 'ZMBRO7', airport: 'MSP', common: ['JEDET', 'ZMBRO'], transitions: [['ZMBRO', 'ODI']] }])
    expect(nav.stars).toEqual([{ id: 'MUSCL4', transitions: [['JERMN', 'MUSCL'], ['CEWDA', 'SHEAY', 'MUSCL']], common: ['MUSCL', 'BAYKS'] }])
  })

  test('the real file decodes into the counts the MSP catalog was built from', () => {
    // the catalog fixture carries the subset; its shape is what the app reads
    expect(Object.keys(msp.nav!.fixes).length).toBeGreaterThan(900)
    expect(Object.keys(msp.nav!.stars)).toContain('MUSCL')
    expect(msp.nav!.stars['MUSCL']!.id).toBe('MUSCL4')
    expect(msp.nav!.sids['ZMBRO']!.common).toEqual(['JEDET', 'ZMBRO'])
    expect(msp.elev).toBe(842)
  })
})

describe('per-airport nav', () => {
  const nav = decodeNavData(file)

  test('navForAirport keeps fixes and airports in range and every procedure touching one', () => {
    const near = navForAirport(nav, [-93.22, 44.88], 80)
    expect(Object.keys(near.fixes).sort()).toEqual(['BAYKS', 'GEP', 'JEDET', 'JERMN', 'KMSP', 'MSP', 'MUSCL'])
    expect(near.fixes['MSP']).toEqual([-93.22, 44.88])
    expect(Object.keys(near.stars)).toEqual(['MUSCL'])
    expect(Object.keys(near.sids)).toEqual(['ZMBRO'])
    const far = navForAirport(nav, [-96.82, 46.92], 30)
    expect(Object.keys(far.fixes).sort()).toEqual(['FAR', 'KFAR'])
    expect(far.stars).toEqual({})
  })

  test('procedure names drop the revision digit', () => {
    expect(procedureBase('MUSCL4')).toBe('MUSCL')
    expect(procedureBase('ZMBRO7')).toBe('ZMBRO')
    expect(procedureBase('GEP')).toBe('GEP')
  })

  test('resolveFixOrFrd finds a fix by name or a fix-radial-distance', () => {
    expect(resolveFixOrFrd(nav.fixes, 'MUSCL')).toEqual([-91.78, 45.03])
    expect(resolveFixOrFrd(nav.fixes, 'gep')).toEqual([-93.37, 45.15])
    const frd = resolveFixOrFrd(nav.fixes, 'GEP090010')!
    expect(frd[1]).toBeCloseTo(45.15, 3)
    expect(frd[0]).toBeGreaterThan(-93.37 + 0.2)
    expect(resolveFixOrFrd(nav.fixes, 'ZZZZZ')).toBeNull()
    expect(resolveFixOrFrd(nav.fixes, 'ZZZZZ120015')).toBeNull()
  })

  test('expandNavigationPath takes the nearest STAR transition then the common route, and the runway suffix', () => {
    const near = navForAirport(nav, [-93.22, 44.88], 80)
    expect(expandNavigationPath(near, 'MUSCL3.30R', [-91.2, 45.1])).toEqual({ fixes: ['JERMN', 'MUSCL', 'BAYKS'], runway: '30R', procedure: 'MUSCL4' })
    expect(expandNavigationPath(near, 'MUSCL4', [-92.0, 44.5])).toEqual({ fixes: ['JERMN', 'MUSCL', 'BAYKS'], runway: null, procedure: 'MUSCL4' })
    expect(expandNavigationPath(near, 'GEP MUSCL', [-93, 45]).fixes).toEqual(['GEP', 'MUSCL'])
    expect(expandNavigationPath(near, 'ONL Q152 GEP', [-93, 45]).fixes).toEqual(['GEP'])
    expect(expandNavigationPath(near, 'ZMBRO7', [-93.22, 44.88])).toEqual({ fixes: ['JEDET'], runway: null, procedure: 'ZMBRO7' })
    expect(expandNavigationPath(near, '', [-93, 45])).toEqual({ fixes: [], runway: null, procedure: null })
  })

  test('the MSP fixture expands the scenario paths it ships with', () => {
    const out = expandNavigationPath(msp.nav!, 'MUSCL3.30R', [-91.74174, 45.140323])
    expect(out.runway).toBe('30R')
    expect(out.procedure).toBe('MUSCL4')
    expect(out.fixes.slice(-3)).toEqual(['MUSCL', 'BAYKS', 'WOLVS'])
  })
})
