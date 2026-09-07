import { describe, expect, test } from 'bun:test'

import { AtcCommand, isGlobalCommand, parseAltitude, parseCommandLine } from '../src/domain/commands'
import { groundWorld } from './helpers'

describe('command parser', () => {
  const world = groundWorld()

  const parsed = (text: string, selected: string | null = null) => {
    const r = parseCommandLine(world, selected, text)
    if (r._tag !== 'Parsed') {
      throw new Error(`${text}: ${JSON.stringify(r)}`)
    }
    return r
  }

  test('a leading callsign selects, exact or unique prefix/suffix', () => {
    expect(parsed('AAL894 PUSH').callsign).toBe('AAL894')
    expect(parsed('aal894 push').callsign).toBe('AAL894')
    expect(parsed('894 PUSH').callsign).toBe('AAL894')
    expect(parsed('PUSH', 'DAL2057').callsign).toBe('DAL2057')
    expect(parsed('PUSH').callsign).toBeNull()
  })

  test('an ambiguous callsign is not a selection, so the line is not a command', () => {
    expect(parseCommandLine(world, null, 'DAL PUSH')).toEqual({ _tag: 'Unknown' })
    expect(parseCommandLine(world, null, 'cleared to land runway 30L')).toEqual({ _tag: 'Unknown' })
    expect(parseCommandLine(world, null, '   ')).toEqual({ _tag: 'Empty' })
  })

  test('ground commands', () => {
    expect(parsed('PUSH').command).toEqual(AtcCommand.Push({ taxiway: null }))
    expect(parsed('PUSH d').command).toEqual(AtcCommand.Push({ taxiway: 'D' }))
    expect(parsed('TAXI d w w3 HS a3').command).toEqual(AtcCommand.Taxi({ via: ['D', 'W', 'W3'], cross: [], holdShort: 'A3' }))
    expect(parsed('TAXI A e16').command).toEqual(AtcCommand.Taxi({ via: ['A', 'E16'], cross: [], holdShort: null }))
    expect(parseCommandLine(world, null, 'TAXI')).toEqual({ _tag: 'Invalid', callsign: null, error: 'taxi where?' })
    expect(parsed('RWY 30l TAXI d a HS 12R').command).toEqual(AtcCommand.Runway({ runway: '30L', via: ['D', 'A'], cross: [], holdShort: '12R' }))
    expect(parsed('RWY 30L d a').command).toEqual(AtcCommand.Runway({ runway: '30L', via: ['D', 'A'], cross: [], holdShort: null }))
    expect(parsed('RWY 17 TAXI a CROSS 4 12r').command).toEqual(AtcCommand.Runway({ runway: '17', via: ['A'], cross: ['4', '12R'], holdShort: null }))
    expect(parsed('RWY 17 CROSS 4 HS 12R').command).toEqual(AtcCommand.Runway({ runway: '17', via: [], cross: ['4'], holdShort: '12R' }))
    expect(parsed('TAXI a HS 12R CROSS 4').command).toEqual(AtcCommand.Taxi({ via: ['A'], cross: ['4'], holdShort: '12R' }))
    expect(parsed('TAXI a w10 cross 4 cross 12R').command).toEqual(AtcCommand.Taxi({ via: ['A', 'W10'], cross: ['4', '12R'], holdShort: null }))
    expect(parseCommandLine(world, null, 'TAXI CROSS 4')).toMatchObject({ _tag: 'Invalid', error: 'taxi where?' })
    expect(parseCommandLine(world, null, 'RWY')).toMatchObject({ _tag: 'Invalid', error: 'which runway?' })
    expect(parsed('HS a3').command).toEqual(AtcCommand.HoldShort({ point: 'A3' }))
    expect(parseCommandLine(world, null, 'HS')).toMatchObject({ _tag: 'Invalid', error: 'hold short of what?' })
    expect(parsed('CROSS').command).toEqual(AtcCommand.Cross({ runway: null }))
    expect(parsed('CROSS 12r').command).toEqual(AtcCommand.Cross({ runway: '12R' }))
    expect(parsed('RES').command).toEqual(AtcCommand.Resume())
    expect(parsed('HOLD').command).toEqual(AtcCommand.Hold())
    expect(parsed('BREAK').command).toEqual(AtcCommand.Break())
    expect(parsed('GIVEWAY dal2057').command).toEqual(AtcCommand.GiveWay({ callsign: 'DAL2057' }))
    expect(parsed('GW dal2057').command).toEqual(AtcCommand.GiveWay({ callsign: 'DAL2057' }))
    expect(parseCommandLine(world, null, 'GW')).toMatchObject({ _tag: 'Invalid', error: 'give way to whom?' })
    expect(parsed('TAXIALL').command).toEqual(AtcCommand.TaxiAll())
  })

  test('tower commands', () => {
    expect(parsed('LUAW').command).toEqual(AtcCommand.LineUpAndWait())
    expect(parsed('CTO').command).toEqual(AtcCommand.ClearedForTakeoff({ heading: null, turn: null }))
    expect(parsed('CTO 270').command).toEqual(AtcCommand.ClearedForTakeoff({ heading: 270, turn: null }))
    expect(parsed('CTO L 270').command).toEqual(AtcCommand.ClearedForTakeoff({ heading: 270, turn: 'L' }))
    expect(parsed('CTO r 090').command).toEqual(AtcCommand.ClearedForTakeoff({ heading: 90, turn: 'R' }))
    expect(parsed('CTO TL 270').command).toEqual(AtcCommand.ClearedForTakeoff({ heading: 270, turn: 'L' }))
    expect(parsed('CTO FH 360').command).toEqual(AtcCommand.ClearedForTakeoff({ heading: 360, turn: null }))
    expect(parseCommandLine(world, null, 'CTO L')).toMatchObject({ _tag: 'Invalid', error: 'heading?' })
    expect(parseCommandLine(world, null, 'CTO 400')).toMatchObject({ _tag: 'Invalid', error: 'heading?' })
    expect(parsed('EXIT').command).toEqual(AtcCommand.Exit())
    expect(parsed('CTL').command).toEqual(AtcCommand.ClearedToLand())
    expect(parsed('GA').command).toEqual(AtcCommand.GoAround())
    expect(parsed('CD').command).toEqual(AtcCommand.ContactDeparture())
    expect(parsed('FH 90').command).toEqual(AtcCommand.FlyHeading({ heading: 90, turn: null }))
    expect(parsed('TL 270').command).toEqual(AtcCommand.FlyHeading({ heading: 270, turn: 'L' }))
    expect(parsed('TR 360').command).toEqual(AtcCommand.FlyHeading({ heading: 360, turn: 'R' }))
    expect(parseCommandLine(world, null, 'FH 0')).toMatchObject({ _tag: 'Invalid', error: 'heading?' })
    expect(parseCommandLine(world, null, 'FH abc')).toMatchObject({ _tag: 'Invalid', error: 'heading?' })
    expect(parsed('CM 50').command).toEqual(AtcCommand.ClimbMaintain({ altitude: 5000 }))
    expect(parsed('CM 17500').command).toEqual(AtcCommand.ClimbMaintain({ altitude: 17500 }))
    expect(parsed('CM FL230').command).toEqual(AtcCommand.ClimbMaintain({ altitude: 23000 }))
    expect(parseCommandLine(world, null, 'CM')).toMatchObject({ _tag: 'Invalid', error: 'altitude?' })
    expect(parsed('TRACK').command).toEqual(AtcCommand.Track())
    expect(parsed('IC').command).toEqual(AtcCommand.Track())
    expect(parsed('DROP').command).toEqual(AtcCommand.Drop())
    expect(parsed('DT').command).toEqual(AtcCommand.Drop())
  })

  test('transponder, say, delete and global commands', () => {
    expect(parsed('SQ 4521').command).toEqual(AtcCommand.Squawk({ code: '4521' }))
    expect(parseCommandLine(world, null, 'SQ')).toMatchObject({ _tag: 'Invalid', error: 'squawk what?' })
    expect(parsed('SN').command).toEqual(AtcCommand.SquawkNormal())
    expect(parsed('SS').command).toEqual(AtcCommand.SquawkStandby())
    expect(parsed('ID').command).toEqual(AtcCommand.Ident())
    expect(parsed('SAY gate').command).toEqual(AtcCommand.Say({ what: 'GATE' }))
    expect(parsed('DEL').command).toEqual(AtcCommand.Delete())
    expect(parsed('PAUSE').command).toEqual(AtcCommand.Pause())
    expect(parsed('UNPAUSE').command).toEqual(AtcCommand.Unpause())
    expect(parsed('SIMRATE 4').command).toEqual(AtcCommand.SimRate({ rate: 4 }))
    expect(parsed('SIMRATE 99').command).toEqual(AtcCommand.SimRate({ rate: 8 }))
    expect(parsed('SIMRATE').command).toEqual(AtcCommand.SimRate({ rate: 1 }))
    expect(isGlobalCommand(AtcCommand.SimRate({ rate: 1 }))).toBe(true)
    expect(isGlobalCommand(AtcCommand.Push({ taxiway: null }))).toBe(false)
  })

  test('altitude shorthand', () => {
    expect(parseAltitude('50')).toBe(5000)
    expect(parseAltitude('450')).toBe(45000)
    expect(parseAltitude('451')).toBe(451)
    expect(parseAltitude('FL050')).toBe(5000)
    expect(parseAltitude('0')).toBeNull()
    expect(parseAltitude(undefined)).toBeNull()
  })

  test('Approach verbs: DCT/PD, SPD, DM, EXP, CAPP/ILS, CT/HO', () => {
    expect(parsed('AAL894 DCT MUSCL').command).toEqual(AtcCommand.Direct({ fix: 'MUSCL' }))
    expect(parsed('AAL894 PD gep').command).toEqual(AtcCommand.Direct({ fix: 'GEP' }))
    expect(parsed('AAL894 SPD 210').command).toEqual(AtcCommand.Speed({ knots: 210 }))
    expect(parsed('AAL894 SPD').command).toEqual(AtcCommand.Speed({ knots: null }))
    expect(parseCommandLine(world, null, 'AAL894 SPD 20')).toEqual({ _tag: 'Invalid', callsign: 'AAL894', error: 'speed?' })
    expect(parsed('AAL894 DM 4000').command).toEqual(AtcCommand.ClimbMaintain({ altitude: 4000 }))
    expect(parsed('AAL894 DM 40').command).toEqual(AtcCommand.ClimbMaintain({ altitude: 4000 }))
    expect(parsed('AAL894 EXP 30R').command).toEqual(AtcCommand.ExpectRunway({ runway: '30R' }))
    expect(parsed('AAL894 CAPP 30R').command).toEqual(AtcCommand.ClearedApproach({ runway: '30R' }))
    expect(parsed('AAL894 ILS').command).toEqual(AtcCommand.ClearedApproach({ runway: null }))
    expect(parsed('AAL894 CT').command).toEqual(AtcCommand.ContactTower())
    expect(parsed('AAL894 HO').command).toEqual(AtcCommand.ContactTower())
    expect(parseCommandLine(world, null, 'AAL894 DCT')).toEqual({ _tag: 'Invalid', callsign: 'AAL894', error: 'direct where?' })
  })
})
