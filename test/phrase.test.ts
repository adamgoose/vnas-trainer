import { describe, expect, test } from 'bun:test'

import { altitudeWords, callsign, digitWords, digits, frequency, gate, groupNumber, numberWords, phrase, runway, spokenCallsign, spokenFreeText, spokenFrequency, spokenIdent, spokenRunway, spoken, taxiways, written } from '../src/domain/phrase'

describe('phraseology', () => {
  test('runways', () => {
    expect(spokenRunway('30L')).toBe('three zero left')
    expect(spokenRunway('4')).toBe('four')
    expect(spokenRunway('12R-30L')).toBe('one two right, three zero left')
    expect(spokenRunway('9C')).toBe('niner center')
  })

  test('taxiways, gates and spots', () => {
    expect(spokenIdent('A1')).toBe('alpha one')
    expect(spokenIdent('ALLEY')).toBe('alley')
    expect(spokenIdent('W9')).toBe('whiskey niner')
    expect(spokenIdent('Q C W3')).toBe('quebec, charlie, whiskey three')
    expect(spokenIdent('E16')).toBe('echo one six')
  })

  test('frequencies drop trailing zeros', () => {
    expect(spokenFrequency('124.700')).toBe('one two four point seven')
    expect(spokenFrequency('126.725')).toBe('one two six point seven two five')
    expect(spokenFrequency('121.000')).toBe('one two one point zero')
  })

  test('squawks and headings digit by digit', () => {
    expect(digitWords('4521')).toBe('four five two one')
    expect(digitWords('090')).toBe('zero niner zero')
  })

  test('altitudes', () => {
    expect(altitudeWords(5000)).toBe('five thousand')
    expect(altitudeWords(17500)).toBe('one seven thousand five hundred')
    expect(altitudeWords(18000)).toBe('flight level one eight zero')
    expect(altitudeWords(23000)).toBe('flight level two three zero')
    expect(altitudeWords(500)).toBe('five hundred')
  })

  test('flight numbers combine', () => {
    expect(groupNumber('1047')).toBe('ten forty-seven')
    expect(groupNumber('1992')).toBe('nineteen ninety-two')
    expect(groupNumber('894')).toBe('eight ninety-four')
    expect(groupNumber('1004')).toBe('ten zero four')
    expect(groupNumber('1200')).toBe('twelve hundred')
    expect(groupNumber('800')).toBe('eight hundred')
    expect(groupNumber('52')).toBe('fifty-two')
    expect(numberWords(6)).toBe('six')
  })

  test('callsigns', () => {
    expect(spokenCallsign('DAL1047')).toBe('Delta ten forty-seven')
    expect(spokenCallsign('AAL894')).toBe('American eight ninety-four')
    expect(spokenCallsign('SKW3892')).toBe('SkyWest thirty-eight ninety-two')
    expect(spokenCallsign('N2382R')).toBe('november two three eight two romeo')
    expect(spokenCallsign('XYZ123')).toBe('x-ray yankee zulu one two three')
    expect(spokenCallsign('DAL52A')).toBe('Delta fifty-two alpha')
  })

  test('phrases render written and spoken forms', () => {
    const p = phrase('Minneapolis Tower,', callsign('DAL1047'), ', six mile final, runway', runway('30R'))
    expect(written(p)).toBe('Minneapolis Tower, DAL1047, six mile final, runway 30R')
    expect(spoken(p)).toBe('Minneapolis Tower, Delta ten forty-seven, six mile final, runway three zero right')
    const t = phrase('runway', runway('30L'), ', taxi via', taxiways(['D', 'W', 'W3']), runway('12R-30L'), taxiways(['A']))
    expect(written(t)).toBe('runway 30L, taxi via D W W3 12R-30L A')
    expect(spoken(t)).toBe('runway three zero left, taxi via delta, whiskey, whiskey three one two right, three zero left alpha')
    expect(spoken(phrase('over to Minneapolis Departure', frequency('124.700')))).toBe('over to Minneapolis Departure one two four point seven')
    expect(spoken(phrase('squawking', digits('4521')))).toBe('squawking four five two one')
    expect(spoken(phrase('in the blocks at', gate('E16')))).toBe('in the blocks at echo one six')
  })

  test('free text gets a best-effort spoken form', () => {
    expect(spokenFreeText('DAL1047 runway 30L taxi via A B, hold short 12R')).toBe(
      'Delta ten forty-seven runway three zero left taxi via alpha bravo, hold short one two right',
    )
    expect(spokenFreeText('Delta 1047 contact departure 124.700')).toBe('Delta ten forty-seven contact departure one two four point seven')
    expect(spokenFreeText('N2382R squawk 4521 heading 090')).toBe(
      'november two three eight two romeo squawk four five two one heading zero niner zero',
    )
  })
})
