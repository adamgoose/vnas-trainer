import { describe, expect, test } from 'bun:test'
import { Scene } from 'foldkit/test'

import { Speak } from '../src/app/commands'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { update } from '../src/app/update'
import { defaultSettings } from '../src/services/settings'
import { deckView } from '../src/view/deck'
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

/** A session long past the 140 lines the log used to keep. */
const longSession = (): Model => {
  let m = ready()
  for (let i = 0; i < 150; i++) {
    m = update(update(m, Message.UpdatedCommandText({ value: 'AAL894 PUSH' })).model, Message.SubmittedCommand()).model
  }
  return m
}

describe('the deck log', () => {
  test('draws every line of a long session, and the memoised list refreshes when one arrives', () => {
    const m = longSession()
    expect(m.log.length).toBeGreaterThan(300)
    const oldest = m.log.at(-1)!.text
    Scene.scene(
      { update, view: deckView },
      Scene.given(m),
      Scene.tap((s) => {
        const lines = Scene.findAll(s.html, '.line')
        expect(lines).toHaveLength(m.log.length)
        // newest first in the array; CSS reverses the column, so the oldest line is the last element
        expect(Scene.textContent(lines[0]!)).toContain(m.log[0]!.text)
        expect(Scene.textContent(lines.at(-1)!)).toContain(oldest)
      }),
      Scene.type('#cmd', 'AAL894 RWY 30L'),
      Scene.submit('.cmdform'),
      Scene.Command.resolve(Speak, Message.CompletedSpeak()),
      Scene.tap((s) => {
        const lines = Scene.findAll(s.html, '.line')
        expect(lines.length).toBeGreaterThan(m.log.length)
        // the pilot's readback on top, the controller's line under it, and the oldest line still at the far end
        expect(Scene.textContent(lines[1]!)).toContain('AAL894 RWY 30L')
        expect(Scene.textContent(lines.at(-1)!)).toContain(oldest)
      }),
    )
  })
})
