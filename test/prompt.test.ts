import { describe, expect, test } from 'bun:test'

import { buildPrompt, parseJsonish, parseTranslation } from '../src/domain/prompt'
import { browserVoiceParams, callsignHash, englishVoices, pickProviderVoice, professionalVoices } from '../src/domain/voices'
import { encodeWav, toBase64 } from '../src/domain/wav'
import { groundWorld, msp, scenarioNamed } from './helpers'
import { TRACON_RULES } from '../src/domain/rules'
import { loadScenario } from '../src/domain/scenario'
import { makeWorld } from '../src/domain/world'

const traconWorld = () => loadScenario(makeWorld(msp, TRACON_RULES, 1), scenarioNamed('Ancient MSP APP North')).world

describe('prompt', () => {
  test('lists the airport, runways and taxiways with spoken forms, the roster and the selection', () => {
    const world = groundWorld()
    const p = buildPrompt({ world, airportName: 'Minneapolis ATCT', positionLabel: 'Ground', selected: 'AAL894', audio: false })
    expect(p.system).toContain('at Minneapolis ATCT (MSP)')
    expect(p.system).toContain('working the Ground position')
    expect(p.system).toContain('30L (three zero left)')
    expect(p.system).toContain('A1 (alpha one)')
    expect(p.system).toContain('ALLEY')
    expect(p.system).toContain('Departure frequency: 124.700 (Minneapolis Departure)')
    expect(p.system).toContain('Delta = DAL')
    expect(p.system).not.toContain('AUDIO:')
    expect(p.system).not.toContain('"transcript"')
    expect(p.user).toContain('AAL894 (B738) PARKED gate E16')
    expect(p.user).toContain('CURRENTLY SELECTED: AAL894')
    expect(p.system).toContain('Arrivals (STARs): ')
    expect(p.system).not.toContain('Fixes on aircraft routes')
    const tracon = buildPrompt({ world: traconWorld(), airportName: 'Minneapolis ATCT', positionLabel: 'Approach', selected: null, audio: false })
    expect(tracon.system).toContain('working the Approach position')
    expect(tracon.system).toContain('Fixes on aircraft routes: ')
    expect(tracon.system).toContain('MUSCL')
    expect(tracon.system).toContain('CAPP 30R')
    const audio = buildPrompt({ world, airportName: 'Minneapolis ATCT', positionLabel: 'Local', selected: null, audio: true })
    expect(audio.system).toContain('AUDIO:')
    expect(audio.system).toContain('"transcript"')
    expect(audio.user).toContain('CURRENTLY SELECTED: none')
  })

  test('parses fenced or prose-wrapped JSON and tolerates missing fields', () => {
    expect(parseJsonish('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseJsonish('Sure! {"a":1} there')).toEqual({ a: 1 })
    expect(() => parseJsonish('nothing')).toThrow('no JSON in reply')
    expect(parseTranslation('{"callsign":"AAL894","commands":["PUSH"," "],"readback":"Push approved, American 894"}')).toEqual({
      transcript: null,
      callsign: 'AAL894',
      commands: ['PUSH'],
      readback: 'Push approved, American 894',
      spoken: null,
    })
    expect(parseTranslation('{}')).toEqual({ transcript: null, callsign: null, commands: [], readback: null, spoken: null })
    expect(() => parseTranslation('[1]')).toThrow('not an object')
  })
})

describe('voices', () => {
  test('hashes are stable and spread rate and pitch', () => {
    expect(callsignHash('DAL1047')).toBe(callsignHash('DAL1047'))
    expect(callsignHash('DAL1047')).not.toBe(callsignHash('DAL1048'))
    const p = browserVoiceParams('DAL1047', 5)
    expect(p.index).toBeLessThan(5)
    expect(p.rate).toBeGreaterThanOrEqual(1.05)
    expect(p.pitch).toBeGreaterThanOrEqual(0.85)
    expect(browserVoiceParams('X', 0).index).toBe(0)
  })

  test('filters to English, professional voices and falls back to the whole list', () => {
    expect(englishVoices(['af_heart', 'jf_alpha', 'en-US-x', 'zh_yunxi'])).toEqual(['af_heart', 'en-US-x'])
    expect(englishVoices(['zh_a', 'ja_b'])).toEqual(['zh_a', 'ja_b'])
    expect(professionalVoices(['Aria', 'Aria_whisper', 'Guy_neutral', 'Guy_angry', 'Santa'])).toEqual(['Aria', 'Guy_neutral'])
    expect(professionalVoices(['Santa'])).toEqual(['Santa'])
    expect(pickProviderVoice('DAL1', ['a', 'b'], 'chosen')).toBe('chosen')
    expect(pickProviderVoice('DAL1', null, '')).toBeUndefined()
    expect(['af_heart', 'am_adam']).toContain(pickProviderVoice('DAL1', ['af_heart', 'am_adam', 'jf_alpha'], '') ?? '')
  })
})

describe('wav', () => {
  test('writes a 16 kHz mono 16-bit header and clamps samples', () => {
    const bytes = encodeWav(new Float32Array([0, 0.5, -0.5, 2, -2]), 16000)
    const view = new DataView(bytes.buffer)
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('WAVE')
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(10)
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(Math.trunc(0.5 * 0x7fff))
    expect(view.getInt16(50, true)).toBe(0x7fff)
    expect(view.getInt16(52, true)).toBe(-0x8000)
    expect(toBase64(new Uint8Array([82, 73, 70, 70]))).toBe('UklGRg==')
  })
})
