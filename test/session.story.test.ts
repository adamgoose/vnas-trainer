import { describe, expect, test } from 'bun:test'
import { Command, given, message, model, story } from 'foldkit/story'

import { FocusCommand, HostRoom, JoinRoom, LeaveRoom, LoadAirport, LoadArtcc, LoadIndex, LoadPavement, ProbeRecognition, ReadDeepLink, ReplaceDeepLink, SaveSettings, SendSession, Speak } from '../src/app/commands'
import { LoadStarsMap, StarsMessage, defaultMaps } from '../src/positions/local/stars'
import { Message } from '../src/app/message'
import { type Model, initialModel, worldOf } from '../src/app/model'
import { update } from '../src/app/update'
import { AtcCommand } from '../src/domain/commands'
import { SessionControl, SessionEvent, type Snapshot, decodeSessionEvent, encodeSessionEvent, isRoomCode, normaliseRoomCode } from '../src/domain/session'
import { defaultSettings } from '../src/services/settings'
import { DataSource } from '../src/services/vnasData'
import { msp } from './helpers'

const surfaceCount = (s: (typeof msp.scen)[number]) => s.ac.filter((a) => a.k !== 'A').length
const big = msp.scen.reduce((best, s) => (surfaceCount(s) > surfaceCount(best) ? s : best), msp.scen[0]!)
const index = { built: '', artccs: [{ id: 'ZMP', name: 'Minneapolis ARTCC', airports: [{ id: 'MSP', name: 'Minneapolis ATCT', n: 64, asdex: true, gates: 220, taxi: 106, stars: true }] }] }

const ready = (): Model => {
  let m = update(initialModel, Message.CompletedLoadSettings({ settings: defaultSettings })).model
  m = update(m, Message.CompletedReadDeepLink({ airport: 'MSP', scenario: big.id, room: null })).model
  m = update(m, Message.ResizedScope({ width: 1000, height: 700, devicePixelRatio: 1 })).model
  m = update(m, Message.CompletedLoadIndex({ index })).model
  m = update(m, Message.CompletedLoadAirport({ airport: msp })).model
  m = update(m, Message.CompletedLoadScenario({ airportId: 'MSP', scenario: big })).model
  return m
}

const hosting = (): Model => {
  let m = update(ready(), Message.ClickedHostSession()).model
  m = update(m, Message.CompletedHostRoom({ room: 'ABC234' })).model
  return m
}

const snapshotOf = (m: Model): Snapshot => ({
  airportId: 'MSP',
  artcc: 'ZMP',
  scenarioId: big.id,
  world: worldOf(m)!,
  running: true,
  rate: 2,
  mode: 'tower',
})

describe('session protocol', () => {
  test('room codes normalise and validate', () => {
    expect(normaliseRoomCode(' abc-234 ')).toBe('ABC234')
    expect(normaliseRoomCode('o1lz23')).toBe('01LZ23')
    expect(isRoomCode('ABC234')).toBe(true)
    expect(isRoomCode('ABC23')).toBe(false)
    expect(isRoomCode('ABC01O')).toBe(false)
  })

  test('events round-trip through JSON, snapshot included', () => {
    const m = ready()
    const event = SessionEvent.Snapshot({ snapshot: snapshotOf(m) })
    const wire = JSON.parse(JSON.stringify(encodeSessionEvent(event)))
    const back = decodeSessionEvent(wire)
    expect(back).toEqual(event)
    const cmd = SessionEvent.Commanded({ callsign: 'AAL894', command: AtcCommand.Runway({ runway: '30L', at: null, via: ['D'], cross: [], holdShort: null }), said: 'AAL894 RWY 30L D' })
    expect(decodeSessionEvent(JSON.parse(JSON.stringify(encodeSessionEvent(cmd))))).toEqual(cmd)
  })
})

describe('hosting', () => {
  test('hosting creates a room; a joining peer gets a snapshot; ticks and commands are broadcast', () => {
    story(
      update,
      given(ready()),
      message(Message.ClickedHostSession()),
      Command.expectExact(HostRoom({ turn: null })),
      Command.resolve(HostRoom, Message.CompletedHostRoom({ room: 'ABC234' })),
      model((m) => {
        expect(m.session).toMatchObject({ role: 'host', room: 'ABC234', status: 'connected' })
        expect(m.log[0]?.text).toBe('hosting session ABC234 — share the code or the link')
      }),
      message(Message.PeerJoined({ peerId: 'peer-1-abcdef' })),
      Command.expectExact(SendSession),
      model((m) => expect(m.session.peers).toEqual(['peer-1-abcdef'])),
      Command.resolve(SendSession, Message.CompletedSendSession()),
      message(Message.Ticked({ now: 1000 })),
      message(Message.Ticked({ now: 1300 })),
      Command.expectExact(SendSession({ event: SessionEvent.Stepped({ steps: 3 }), target: null })),
      Command.resolve(SendSession, Message.CompletedSendSession()),
      message(Message.UpdatedCommandText({ value: 'AAL894 PUSH' })),
      message(Message.SubmittedCommand()),
      Command.expectExact(Speak, SendSession({ event: SessionEvent.Commanded({ callsign: 'AAL894', command: AtcCommand.Push({ taxiway: null }), said: 'AAL894 PUSH' }), target: null })),
      Command.resolve(Speak, Message.CompletedSpeak()),
      Command.resolve(SendSession, Message.CompletedSendSession()),
      model((m) => expect(worldOf(m)!.aircraft.find((a) => a.callsign === 'AAL894')!.state).toBe('PUSH')),
    )
  })

  test('a guest request is executed on the host and broadcast; controls likewise', () => {
    story(
      update,
      given(hosting()),
      message(Message.ClickedStrip({ callsign: 'DAL2057' })),
      Command.resolve(FocusCommand, Message.CompletedFocusCommand()),
      message(Message.ReceivedSession({ peerId: 'guest-1', event: SessionEvent.RequestedCommand({ callsign: 'AAL894', command: AtcCommand.Push({ taxiway: null }), said: 'AAL894 PUSH' }) })),
      Command.expectExact(Speak, SendSession({ event: SessionEvent.Commanded({ callsign: 'AAL894', command: AtcCommand.Push({ taxiway: null }), said: 'AAL894 PUSH' }), target: null })),
      Command.resolve(Speak, Message.CompletedSpeak()),
      Command.resolve(SendSession, Message.CompletedSendSession()),
      model((m) => {
        expect(m.selected).toBe('DAL2057')
        expect(m.log[1]?.text).toBe('AAL894 PUSH')
        expect(m.log[0]?.text).toBe('pushing back off E16')
      }),
      message(Message.ReceivedSession({ peerId: 'guest-1', event: SessionEvent.RequestedControl({ control: SessionControl.SetRate({ rate: 4 }) }) })),
      Command.expectExact(SendSession({ event: SessionEvent.Controlled({ control: SessionControl.SetRate({ rate: 4 }) }), target: null })),
      Command.resolve(SendSession, Message.CompletedSendSession()),
      model((m) => expect(m.rate).toBe(4)),
      message(Message.ClickedTogglePlay()),
      Command.expectExact(SendSession({ event: SessionEvent.Controlled({ control: SessionControl.SetRunning({ running: false }) }), target: null })),
      Command.resolve(SendSession, Message.CompletedSendSession()),
      model((m) => expect(m.running).toBe(false)),
    )
  })

  test('a scenario change on the host broadcasts a fresh snapshot', () => {
    story(
      update,
      given(hosting()),
      message(Message.ChangedScenario({ id: '' })),
      Command.expectHas(SendSession),
      Command.resolve(ReplaceDeepLink, Message.CompletedReplaceDeepLink()),
      Command.resolve(SendSession, Message.CompletedSendSession()),
      model((m) => expect(worldOf(m)!.aircraft).toHaveLength(0)),
    )
  })
})

describe('joining', () => {
  test('a join link joins as guest, the snapshot loads the airport and takes the host picture', () => {
    const hostModel = hosting()
    const snapshot = snapshotOf(hostModel)
    story(
      update,
      given(initialModel),
      message(Message.CompletedLoadSettings({ settings: defaultSettings })),
      Command.resolve(ProbeRecognition, Message.CompletedProbeRecognition({ available: false })),
      Command.resolve(ReadDeepLink, Message.CompletedReadDeepLink({ airport: null, scenario: null, room: 'ABC234' })),
      Command.expectHas(JoinRoom({ room: 'ABC234', turn: null }), LoadIndex),
      Command.resolve(JoinRoom, Message.CompletedJoinRoom({ room: 'ABC234' })),
      model((m) => expect(m.session).toMatchObject({ role: 'guest', room: 'ABC234', status: 'connecting' })),
      Command.resolve(LoadIndex, Message.CompletedLoadIndex({ index })),
      Command.resolve(LoadArtcc, Message.FailedLoadArtcc({ id: 'ZMP', error: 'skipped' })),
      Command.resolve(LoadAirport, Message.FailedLoadAirport({ id: 'MSP', error: 'skipped' })),
      message(Message.ReceivedSession({ peerId: 'host-1', event: SessionEvent.Snapshot({ snapshot }) })),
      Command.expectExact(LoadArtcc({ source: DataSource.Catalog(), id: 'ZMP' })),
      Command.resolve(LoadArtcc, Message.FailedLoadArtcc({ id: 'ZMP', error: 'skipped' })),
      Command.expectExact(LoadAirport({ source: DataSource.Catalog(), id: 'MSP', artcc: 'ZMP' })),
      model((m) => expect(m.session.pendingSnapshot).not.toBeNull()),
      Command.resolve(LoadAirport, Message.CompletedLoadAirport({ airport: msp })),
      Command.expectHas(LoadPavement, SaveSettings),
      Command.resolve(LoadPavement, Message.CompletedLoadPavement({ id: msp.asdex!, asdex: true })),
      Command.resolve(SaveSettings, Message.CompletedSaveSettings()),
      ...defaultMaps(msp.stars).map((id) => Command.resolve(LoadStarsMap({ artcc: 'ZMP', id }), StarsMessage.CompletedLoadMap({ id }))),
      model((m) => {
        expect(m.session).toMatchObject({ role: 'guest', status: 'connected', hostId: 'host-1', pendingSnapshot: null })
        expect(m.rate).toBe(2)
        expect(m.settings.mode).toBe('tower')
        expect(worldOf(m)!.aircraft).toHaveLength(82)
        expect(m.log[0]?.text).toBe('joined session ABC234 — following MSP')
      }),
    )
  })

  test('a guest follows steps and commands from the host, and sends its own as requests', () => {
    let guest = ready()
    guest = { ...guest, session: { ...guest.session, role: 'guest', room: 'ABC234', status: 'connected', hostId: 'host-1' } }
    story(
      update,
      given(guest),
      message(Message.Ticked({ now: 1000 })),
      message(Message.Ticked({ now: 5000 })),
      model((m) => expect(worldOf(m)!.tick).toBe(0)),
      message(Message.ReceivedSession({ peerId: 'host-1', event: SessionEvent.Stepped({ steps: 7 }) })),
      model((m) => expect(worldOf(m)!.tick).toBe(7)),
      message(Message.ReceivedSession({ peerId: 'stranger', event: SessionEvent.Stepped({ steps: 7 }) })),
      model((m) => expect(worldOf(m)!.tick).toBe(7)),
      message(Message.ClickedStrip({ callsign: 'DAL2057' })),
      Command.resolve(FocusCommand, Message.CompletedFocusCommand()),
      message(Message.ReceivedSession({ peerId: 'host-1', event: SessionEvent.Commanded({ callsign: 'AAL894', command: AtcCommand.Push({ taxiway: null }), said: 'AAL894 PUSH' }) })),
      Command.resolve(Speak, Message.CompletedSpeak()),
      model((m) => {
        expect(worldOf(m)!.aircraft.find((a) => a.callsign === 'AAL894')!.state).toBe('PUSH')
        expect(m.log[1]?.text).toBe('AAL894 PUSH')
        /** the peer's command leaves this browser's selection alone */
        expect(m.selected).toBe('DAL2057')
      }),
      message(Message.UpdatedCommandText({ value: 'AAL894 HOLD' })),
      message(Message.SubmittedCommand()),
      Command.expectExact(SendSession({ event: SessionEvent.RequestedCommand({ callsign: 'AAL894', command: AtcCommand.Hold(), said: 'AAL894 HOLD' }), target: 'host-1' })),
      Command.resolve(SendSession, Message.CompletedSendSession()),
      model((m) => expect(worldOf(m)!.aircraft.find((a) => a.callsign === 'AAL894')!.state).toBe('PUSH')),
      message(Message.ChangedRate({ rate: 2 })),
      Command.expectExact(SendSession({ event: SessionEvent.RequestedControl({ control: SessionControl.SetRate({ rate: 2 }) }), target: 'host-1' })),
      Command.resolve(SendSession, Message.CompletedSendSession()),
      model((m) => expect(m.rate).toBe(1)),
      message(Message.ReceivedSession({ peerId: 'host-1', event: SessionEvent.Controlled({ control: SessionControl.SetRate({ rate: 2 }) }) })),
      model((m) => expect(m.rate).toBe(2)),
      message(Message.PeerLeft({ peerId: 'host-1' })),
      Command.expectExact(LeaveRoom),
      Command.resolve(LeaveRoom, Message.CompletedLeaveRoom()),
      model((m) => {
        expect(m.session.role).toBe('solo')
        expect(m.log[0]?.text).toBe('the host left — running solo from here')
      }),
    )
  })

  test('a bad room code is refused; leaving keeps the world', () => {
    story(
      update,
      given({ ...ready(), session: { ...ready().session, roomInput: 'nope' } }),
      message(Message.ClickedJoinSession()),
      Command.expectNone(),
      model((m) => expect(m.session.error).toBe('a room code is six letters and digits')),
      message(Message.UpdatedRoomInput({ value: 'abc 234' })),
      message(Message.ClickedJoinSession()),
      Command.expectExact(JoinRoom({ room: 'ABC234', turn: null })),
      Command.resolve(JoinRoom, Message.FailedJoinRoom({ error: 'relay down' })),
      model((m) => expect(m.session).toMatchObject({ role: 'solo', status: 'failed', error: 'relay down' })),
    )
    story(
      update,
      given({ ...ready(), session: { ...ready().session, role: 'guest', room: 'ABC234', status: 'connecting' } }),
      message(Message.FailedSession({ error: 'could not connect to peer' })),
      Command.expectNone(),
      model((m) => {
        expect(m.session).toMatchObject({ role: 'guest', room: 'ABC234', status: 'failed', error: 'could not connect to peer' })
        expect(m.log[0]?.text).toMatch(/^still trying to reach the host/)
      }),
      message(Message.PeerJoined({ peerId: 'host-1' })),
      Command.expectNone(),
      model((m) => expect(m.session).toMatchObject({ role: 'guest', status: 'connected', peers: ['host-1'] })),
    )
    story(
      update,
      given(hosting()),
      message(Message.ClickedLeaveSession()),
      Command.expectExact(LeaveRoom),
      Command.resolve(LeaveRoom, Message.CompletedLeaveRoom()),
      model((m) => {
        expect(m.session.role).toBe('solo')
        expect(worldOf(m)!.aircraft).toHaveLength(82)
      }),
    )
  })
})

