import { describe, expect, test } from 'bun:test'
import { Command, given, message, model, story } from 'foldkit/story'

import { AtcCommand } from '../src/domain/commands'
import { Message, type Model, initialModel, update } from '../src/app/main'
import { msp } from './helpers'

const ready = (): Model => update(initialModel, Message.CompletedLoadAirport({ airport: msp })).model

const ticks = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => message(Message.Ticked({ now: from + (i + 1) * 100 })))

describe('app', () => {
  test('loading the airport builds the world and logs the scenario', () => {
    story(
      update,
      given(initialModel),
      message(Message.CompletedLoadAirport({ airport: msp })),
      Command.expectNone(),
      model((m) => {
        expect(m.load._tag).toBe('Ready')
        if (m.load._tag === 'Ready') {
          expect(m.load.world.aircraft).toHaveLength(82)
        }
        expect(m.log[0]?.text).toMatch(/^KMSP 12s\/17 SLCL 5MIT — 82 surface aircraft/)
      }),
    )
  })

  test('the first tick starts the clock; later ticks step 100 ms each, catching up at most 40 steps', () => {
    story(
      update,
      given(ready()),
      message(Message.Ticked({ now: 1000 })),
      model((m) => {
        expect(m.lastTickAt).toBe(1000)
        if (m.load._tag === 'Ready') {
          expect(m.load.world.tick).toBe(0)
        }
      }),
      ...ticks(1000, 5),
      model((m) => {
        if (m.load._tag === 'Ready') {
          expect(m.load.world.tick).toBe(5)
          expect(m.load.world.simTime).toBeCloseTo(0.5, 6)
        }
      }),
      message(Message.Ticked({ now: 1500 + 60_000 })),
      model((m) => {
        if (m.load._tag === 'Ready') {
          expect(m.load.world.tick).toBe(45)
        }
      }),
    )
  })

  test('sim rate multiplies steps and pausing stops them without a catch-up burst', () => {
    story(
      update,
      given(ready()),
      message(Message.ClickedRate({ rate: 4 })),
      message(Message.Ticked({ now: 0 })),
      message(Message.Ticked({ now: 100 })),
      model((m) => {
        if (m.load._tag === 'Ready') {
          expect(m.load.world.tick).toBe(4)
        }
      }),
      message(Message.ClickedTogglePlay()),
      message(Message.Ticked({ now: 5000 })),
      message(Message.Ticked({ now: 5100 })),
      model((m) => {
        expect(m.running).toBe(false)
        if (m.load._tag === 'Ready') {
          expect(m.load.world.tick).toBe(4)
        }
      }),
      message(Message.ClickedTogglePlay()),
      message(Message.Ticked({ now: 9000 })),
      message(Message.Ticked({ now: 9100 })),
      model((m) => {
        if (m.load._tag === 'Ready') {
          expect(m.load.world.tick).toBe(8)
        }
      }),
    )
  })

  test('a typed command selects the aircraft, logs the readback and records the command', () => {
    story(
      update,
      given(ready()),
      message(Message.UpdatedCommandText({ value: 'AAL894 PUSH' })),
      message(Message.SubmittedCommand()),
      model((m) => {
        expect(m.commandText).toBe('')
        expect(m.selected).toBe('AAL894')
        expect(m.log[0]).toMatchObject({ kind: 'pilot', who: 'AAL894', text: 'pushing back off E16' })
        expect(m.log[1]).toMatchObject({ kind: 'atc', text: 'AAL894 PUSH' })
        expect(m.commandLog).toEqual([{ tick: 0, callsign: 'AAL894', command: AtcCommand.Push({ taxiway: null }) }])
      }),
      message(Message.UpdatedCommandText({ value: 'PUSH' })),
      message(Message.SubmittedCommand()),
      model((m) => {
        expect(m.log[0]).toMatchObject({ kind: 'err', text: 'unable — not at a gate' })
        expect(m.commandLog).toHaveLength(1)
      }),
      message(Message.UpdatedCommandText({ value: 'taxi to the runway' })),
      message(Message.SubmittedCommand()),
      model((m) => {
        expect(m.log[0]?.kind).toBe('err')
      }),
      message(Message.IssuedCommand({ callsign: null, command: AtcCommand.Pause() })),
      model((m) => {
        expect(m.running).toBe(false)
        expect(m.commandLog).toHaveLength(2)
      }),
    )
  })

  test('the same message sequence reproduces the same model', () => {
    const play = () => {
      let m = ready()
      m = update(m, Message.ClickedArrivals()).model
      m = update(m, Message.UpdatedCommandText({ value: 'AAL894 RWY 30L' })).model
      m = update(m, Message.SubmittedCommand()).model
      for (let i = 0; i <= 600; i++) {
        m = update(m, Message.Ticked({ now: i * 100 })).model
      }
      return m
    }
    expect(play()).toEqual(play())
  })
})
