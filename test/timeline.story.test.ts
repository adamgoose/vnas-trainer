import { describe, expect, test } from 'bun:test'
import { Command, given, message, model, story } from 'foldkit/story'

import { LoadScenario, SendSession, Speak } from '../src/app/commands'
import { Message } from '../src/app/message'
import { type Model, initialModel, worldOf } from '../src/app/model'
import { branchOf } from '../src/app/timeline'
import { init, update } from '../src/app/update'
import { SessionControl, SessionEvent } from '../src/domain/session'
import { defaultSettings } from '../src/services/settings'
import { msp } from './helpers'

const index = { built: '', artccs: [{ id: 'ZMP', name: 'Minneapolis ARTCC', airports: [{ id: 'MSP', name: 'Minneapolis ATCT', n: 64, asdex: true, gates: 220, taxi: 106, stars: true }] }] }
const surfaceCount = (s: (typeof msp.scen)[number]) => s.ac.filter((a) => a.k !== 'A').length
const big = msp.scen.reduce((best, s) => (surfaceCount(s) > surfaceCount(best) ? s : best), msp.scen[0]!)

const ready = (): Model => {
  let m = update(initialModel, Message.CompletedLoadSettings({ settings: defaultSettings })).model
  m = update(m, Message.CompletedReadDeepLink({ airport: 'MSP', scenario: big.id, room: null })).model
  m = update(m, Message.ResizedScope({ width: 1000, height: 700, devicePixelRatio: 1 })).model
  m = update(m, Message.CompletedLoadIndex({ index })).model
  m = update(m, Message.CompletedLoadAirport({ airport: msp })).model
  m = update(m, Message.CompletedLoadScenario({ airportId: 'MSP', scenario: big })).model
  return m
}

/** Wall-clock ticks 100 ms apart: the first one starts the clock, each later one is one sim step at 1×. */
const tick = (m: Model, count: number, from = 1000): Model => {
  let next = update(m, Message.Ticked({ now: from })).model
  for (let i = 1; i <= count; i++) {
    next = update(next, Message.Ticked({ now: from + i * 100 })).model
  }
  return next
}

const line = (m: Model, text: string): Model => update(update(m, Message.UpdatedCommandText({ value: text })).model, Message.SubmittedCommand()).model

const tickOf = (m: Model): number => worldOf(m)!.tick

/** Ten steps, a pushback, twenty more steps: the root branch ends at tick 30 with a mark at 10. */
const played = (): Model => tick(line(tick(ready(), 10), 'AAL894 PUSH'), 20, 2000)

describe('recording', () => {
  test('init has no graph; a scenario starts one; ticks extend it and commands mark it', () => {
    expect(init().model.timeline.branches).toHaveLength(0)
    const m = played()
    expect(tickOf(m)).toBe(30)
    const root = branchOf(m.timeline, 0)!
    expect(m.timeline.current).toBe(0)
    expect(root).toMatchObject({ forkTick: 0, endTick: 30 })
    expect(root.keyframes.map((k) => [k.tick, k.label])).toEqual([
      [0, null],
      [10, 'AAL894 PUSH'],
    ])
  })

  test('the arrival generator and a position change mark the graph too', () => {
    let m = update(played(), Message.ClickedArrivals()).model
    m = update(m, Message.ChangedPosition({ mode: 'tower' })).model
    expect(branchOf(m.timeline, 0)!.keyframes.at(-1)).toMatchObject({ tick: 30, label: 'arrivals on · Local position' })
  })

  test('a new scenario starts the graph over', () => {
    const m = update(update(played(), Message.ChangedScenario({ id: big.id })).model, Message.CompletedLoadScenario({ airportId: 'MSP', scenario: big })).model
    expect(m.timeline.branches).toHaveLength(1)
    expect(branchOf(m.timeline, 0)!.keyframes).toHaveLength(1)
  })
})

describe('rewinding', () => {
  test('stepping back shows the past with the sim paused and the log cut to that moment; commands are refused; Live restores the present', () => {
    story(
      update,
      given(update(played(), Message.ClickedTimeline()).model),
      model((m) => {
        expect(m.timelineOpen).toBe(true)
        expect(m.review).toBeNull()
      }),
      message(Message.SteppedTimeline({ steps: -15 })),
      Command.expectNone(),
      model((m) => {
        expect(m.review).toEqual({ branch: 0, tick: 15, wasRunning: true })
        expect(m.running).toBe(false)
        expect(tickOf(m)).toBe(15)
        expect(worldOf(m)!.aircraft.find((a) => a.callsign === 'AAL894')!.state).toBe('PUSH')
        expect(m.log.some((l) => l.text === 'AAL894 PUSH')).toBe(true)
        expect(m.commandLog).toHaveLength(1)
        expect(branchOf(m.timeline, 0)!.log.length).toBeGreaterThan(0)
      }),
      message(Message.SteppedTimeline({ steps: -10 })),
      model((m) => {
        expect(m.review).toMatchObject({ branch: 0, tick: 5 })
        expect(worldOf(m)!.aircraft.find((a) => a.callsign === 'AAL894')!.state).toBe('PARKED')
        expect(m.log.some((l) => l.text === 'AAL894 PUSH')).toBe(false)
        expect(m.commandLog).toHaveLength(0)
      }),
      message(Message.Ticked({ now: 99999 })),
      model((m) => expect(tickOf(m)).toBe(5)),
      message(Message.UpdatedCommandText({ value: 'AAL894 PUSH' })),
      message(Message.SubmittedCommand()),
      Command.expectNone(),
      model((m) => {
        expect(m.log[0]?.kind).toBe('err')
        expect(m.log[0]?.text).toMatch(/^rewound/)
        expect(tickOf(m)).toBe(5)
        expect(branchOf(m.timeline, 0)!.keyframes).toHaveLength(2)
      }),
      message(Message.ClickedArrivals()),
      model((m) => expect(worldOf(m)!.arrivalsEnabled).toBe(false)),
      message(Message.JumpedTimeline({ to: 'start' })),
      model((m) => expect(m.review).toMatchObject({ tick: 0 })),
      message(Message.JumpedTimeline({ to: 'end' })),
      model((m) => expect(m.review).toMatchObject({ tick: 30 })),
      message(Message.ClickedTimelineLive()),
      Command.expectNone(),
      model((m) => {
        expect(m.review).toBeNull()
        expect(m.running).toBe(true)
        expect(tickOf(m)).toBe(30)
        expect(m.log.some((l) => l.text === 'AAL894 PUSH')).toBe(true)
        expect(m.log.some((l) => l.kind === 'err')).toBe(false)
        expect(m.commandLog).toHaveLength(1)
        expect(m.timeline.branches).toHaveLength(1)
      }),
    )
  })

  test('stepping forward past the live end is a no-op, and so is every scrub on a guest', () => {
    const m = played()
    expect(update(m, Message.SteppedTimeline({ steps: 10 })).model).toBe(m)
    const guest = update(update(m, Message.UpdatedRoomInput({ value: 'ABC234' })).model, Message.ClickedJoinSession()).model
    expect(update(guest, Message.SteppedTimeline({ steps: -10 })).model.review).toBeNull()
    expect(update(guest, Message.ScrubbedTimeline({ fx: 0.1, fy: 0.5 })).model.review).toBeNull()
  })

  test('a press on the lanes picks the branch by row and the tick by position', () => {
    const m = update(played(), Message.ScrubbedTimeline({ fx: 0.02, fy: 0.5 })).model
    expect(m.review).toMatchObject({ branch: 0, tick: 12 })
  })
})

describe('forking', () => {
  test('Resume before the end forks a branch that the ticks extend; the old future stays and can be continued', () => {
    story(
      update,
      given(update(played(), Message.SteppedTimeline({ steps: -10 })).model),
      message(Message.ClickedTimelineResume()),
      Command.expectNone(),
      model((m) => {
        expect(m.review).toBeNull()
        expect(m.running).toBe(true)
        expect(m.timeline.current).toBe(1)
        expect(branchOf(m.timeline, 1)).toMatchObject({ parent: 0, forkTick: 20, endTick: 20 })
        expect(branchOf(m.timeline, 0)!.endTick).toBe(30)
        expect(m.log[0]?.text).toMatch(/^rewound to T\+00:02 — branch 2 forks here/)
      }),
      ...[9000, 9100, 9200, 9300].map((now) => message(Message.Ticked({ now }))),
      message(Message.UpdatedCommandText({ value: 'AAL894 RWY 30L TAXI A' })),
      message(Message.SubmittedCommand()),
      Command.expectExact(Speak),
      Command.resolve(Speak, Message.CompletedSpeak()),
      model((m) => {
        expect(tickOf(m)).toBe(23)
        expect(branchOf(m.timeline, 1)).toMatchObject({ endTick: 23 })
        expect(branchOf(m.timeline, 1)!.keyframes.map((k) => [k.tick, k.label])).toEqual([
          [20, null],
          [23, 'AAL894 RWY 30L TAXI A'],
        ])
        expect(branchOf(m.timeline, 0)!.endTick).toBe(30)
      }),
      // the top lane is the root; its end is tick 30 where AAL894 was still pushing back
      message(Message.ScrubbedTimeline({ fx: 0.05, fy: 0.1 })),
      model((m) => expect(m.review).toEqual({ branch: 0, tick: 30, wasRunning: true })),
      model((m) => expect(worldOf(m)!.aircraft.find((a) => a.callsign === 'AAL894')!.state).toBe('PUSH')),
      message(Message.ClickedTimelineResume()),
      model((m) => {
        expect(m.timeline.current).toBe(0)
        expect(m.timeline.branches).toHaveLength(2)
        expect(m.log[0]?.text).toBe('continuing branch 1 from T+00:03')
        expect(m.log.some((l) => l.text === 'AAL894 RWY 30L TAXI A')).toBe(false)
        expect(tickOf(m)).toBe(30)
      }),
      ...[20000, 20100].map((now) => message(Message.Ticked({ now }))),
      model((m) => {
        expect(branchOf(m.timeline, 0)!.endTick).toBe(31)
        expect(branchOf(m.timeline, 1)!.endTick).toBe(23)
      }),
    )
  })

  test('the play button while rewound resumes as a fork; closing the panel while rewound goes live', () => {
    const rewound = update(update(played(), Message.ClickedTimeline()).model, Message.SteppedTimeline({ steps: -10 })).model
    const played2 = update(rewound, Message.ClickedTogglePlay()).model
    expect(played2.review).toBeNull()
    expect(played2.running).toBe(true)
    expect(played2.timeline.current).toBe(1)
    const closed = update(rewound, Message.ClickedTimeline()).model
    expect(closed.timelineOpen).toBe(false)
    expect(closed.review).toBeNull()
    expect(closed.timeline.branches).toHaveLength(1)
    expect(tickOf(closed)).toBe(30)
  })

  test('a scenario change while rewound starts over with the clock as it was', () => {
    const rewound = update(played(), Message.SteppedTimeline({ steps: -10 })).model
    expect(rewound.running).toBe(false)
    const changed = update(rewound, Message.ChangedScenario({ id: big.id }))
    expect(changed.commands?.some((c) => c.name === LoadScenario.name)).toBe(true)
    const loaded = update(changed.model, Message.CompletedLoadScenario({ airportId: 'MSP', scenario: big })).model
    expect(loaded.review).toBeNull()
    expect(loaded.running).toBe(true)
    expect(loaded.timeline.branches).toHaveLength(1)
  })
})

describe('hosting', () => {
  const hosting = (): Model => update(update(played(), Message.ClickedHostSession()).model, Message.CompletedHostRoom({ room: 'ABC234' })).model

  test('a rewind pauses the peers, a joining peer follows the present, and a fork sends a fresh snapshot', () => {
    story(
      update,
      given(hosting()),
      message(Message.SteppedTimeline({ steps: -10 })),
      Command.expectExact(SendSession({ event: SessionEvent.Controlled({ control: SessionControl.SetRunning({ running: false }) }), target: null })),
      Command.resolve(SendSession, Message.CompletedSendSession()),
      message(Message.SteppedTimeline({ steps: -5 })),
      Command.expectNone(),
      message(Message.PeerJoined({ peerId: 'peer-1-abcdef' })),
      Command.expectExact(SendSession),
      model((m) => expect(tickOf(m)).toBe(15)),
      Command.resolve(SendSession, Message.CompletedSendSession()),
      message(Message.ClickedTimelineResume()),
      Command.expectExact(SendSession, SendSession({ event: SessionEvent.Controlled({ control: SessionControl.SetRunning({ running: true }) }), target: null })),
      model((m) => {
        expect(m.timeline.current).toBe(1)
        expect(tickOf(m)).toBe(15)
      }),
      Command.resolve(SendSession({ event: SessionEvent.Controlled({ control: SessionControl.SetRunning({ running: true }) }), target: null }), Message.CompletedSendSession()),
      Command.resolve(SendSession, Message.CompletedSendSession()),
    )
    const joined = update(update(hosting(), Message.SteppedTimeline({ steps: -10 })).model, Message.PeerJoined({ peerId: 'peer-1-abcdef' }))
    const sent = joined.commands?.find((c) => c.name === SendSession.name)
    const snapshot = (sent?.args as { event: { _tag: string; snapshot?: { world: { tick: number }; running: boolean } } }).event
    expect(snapshot._tag).toBe('Snapshot')
    expect(snapshot.snapshot?.world.tick).toBe(30)
    expect(snapshot.snapshot?.running).toBe(true)
  })
})
