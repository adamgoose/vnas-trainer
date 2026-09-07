import { describe, expect, test } from 'bun:test'
import { Command, given, message, model, story } from 'foldkit/story'

import { FocusCommand, LoadAirport, LoadBrowserVoices, LoadIndex, LoadPavement, LoadScenario, LoadSettings, ProbeRecognition, ReadDeepLink, ReplaceDeepLink, SaveSettings, Speak } from '../src/app/commands'
import { Message } from '../src/app/message'
import { type Model, initialModel, worldOf } from '../src/app/model'
import { init, update } from '../src/app/update'
import { AtcCommand } from '../src/domain/commands'
import { defaultSettings } from '../src/services/settings'
import { DataSource } from '../src/services/vnasData'
import { LoadStarsMap, StarsMessage, defaultMaps } from '../src/positions/local/stars'
import { msp } from './helpers'

const index = {
  built: '',
  artccs: [{ id: 'ZMP', name: 'Minneapolis ARTCC', airports: [{ id: 'MSP', name: 'Minneapolis ATCT', n: 64, asdex: true, gates: 220, taxi: 106, stars: true }, { id: 'FCM', name: 'Flying Cloud', n: 2, asdex: false, gates: 8, taxi: 14, stars: true }] }],
}
const surfaceCount = (s: (typeof msp.scen)[number]) => s.ac.filter((a) => a.k !== 'A').length
const big = msp.scen.reduce((best, s) => (surfaceCount(s) > surfaceCount(best) ? s : best), msp.scen[0]!)
/** the scenario MSP opens on as Ground: the first with surface aircraft (scen[0] is an airborne-only TRACON scenario) */
const first = msp.scen.find((s) => s.ac.some((a) => a.k !== 'A'))!

/** The model after the whole load chain, with the biggest scenario applied. */
const ready = (): Model => {
  let m = update(initialModel, Message.CompletedLoadSettings({ settings: defaultSettings })).model
  m = update(m, Message.CompletedReadDeepLink({ airport: 'MSP', scenario: big.id, room: null })).model
  m = update(m, Message.ResizedScope({ width: 1000, height: 700, devicePixelRatio: 2 })).model
  m = update(m, Message.CompletedLoadIndex({ index })).model
  m = update(m, Message.CompletedLoadAirport({ airport: msp })).model
  m = update(m, Message.CompletedLoadScenario({ airportId: 'MSP', scenario: big })).model
  return m
}

const ticks = (from: number, count: number) => Array.from({ length: count }, (_, i) => message(Message.Ticked({ now: from + (i + 1) * 100 })))

describe('boot chain', () => {
  test('init loads settings, then the deep link, then the index, then the airport, then scenario and pavement', () => {
    const boot = init()
    expect(boot.commands?.map((c) => c.name)).toEqual([LoadSettings.name])
    story(
      update,
      given(initialModel),
      message(Message.CompletedLoadSettings({ settings: defaultSettings })),
      Command.expectExact(ReadDeepLink, ProbeRecognition),
      Command.resolve(ProbeRecognition, Message.CompletedProbeRecognition({ available: false })),
      Command.resolve(ReadDeepLink, Message.CompletedReadDeepLink({ airport: null, scenario: null, room: null })),
      Command.expectExact(LoadIndex({ source: DataSource.Catalog() })),
      Command.resolve(LoadIndex, Message.CompletedLoadIndex({ index })),
      Command.expectExact(LoadAirport({ source: DataSource.Catalog(), id: 'MSP', artcc: 'ZMP' })),
      model((m) => {
        expect(m.airport).toEqual({ _tag: 'Loading', id: 'MSP' })
      }),
      Command.resolve(LoadAirport, Message.CompletedLoadAirport({ airport: msp })),
      Command.expectHas(
        LoadScenario({ source: DataSource.Catalog(), airportId: 'MSP', scenarioId: first.id }),
        LoadPavement({ artcc: 'ZMP', id: msp.asdex!, asdex: true }),
      ),
      model((m) => {
        expect(m.airport._tag).toBe('Ready')
        expect(m.pavement).toEqual({ _tag: 'Loading', id: msp.asdex! })
        expect(m.scenarioLoading).toBe(first.id)
        expect(m.stars.shown).toEqual(defaultMaps(msp.stars))
      }),
      ...defaultMaps(msp.stars).map((id) => Command.resolve(LoadStarsMap({ artcc: 'ZMP', id }), StarsMessage.CompletedLoadMap({ id }))),
      Command.resolve(LoadScenario, Message.CompletedLoadScenario({ airportId: 'MSP', scenario: first })),
      Command.expectExact(LoadPavement({ artcc: 'ZMP', id: msp.asdex!, asdex: true }), ReplaceDeepLink({ airport: 'MSP', scenario: first.id })),
      Command.resolve(ReplaceDeepLink, Message.CompletedReplaceDeepLink()),
      model((m) => {
        expect(worldOf(m)?.aircraft.length).toBe(first.ac.filter((a) => a.k === 'P').length)
        expect(m.log.at(-1)?.text).toMatch(/surface aircraft/)
        expect(m.log[0]?.text).toMatch(/^Ground position\. Select an aircraft, then try: PUSH · RWY/)
      }),
      Command.resolve(LoadPavement, Message.CompletedLoadPavement({ id: msp.asdex!, asdex: true })),
      Command.expectNone(),
      model((m) => {
        expect(m.pavement).toEqual({ _tag: 'Ready', id: msp.asdex!, asdex: true })
      }),
    )
  })

  test('a deep link picks the airport and scenario; otherwise the busiest airport loads', () => {
    story(
      update,
      given({ ...initialModel, deepLink: { airport: 'FCM', scenario: null, room: null } }),
      message(Message.CompletedLoadIndex({ index })),
      Command.expectExact(LoadAirport({ source: DataSource.Catalog(), id: 'FCM', artcc: 'ZMP' })),
      Command.resolve(LoadAirport, Message.FailedLoadAirport({ id: 'FCM', error: 'x' })),
    )
    story(
      update,
      given({ ...initialModel, deepLink: { airport: 'ZZZ', scenario: null, room: null } }),
      message(Message.CompletedLoadIndex({ index })),
      Command.expectExact(LoadAirport({ source: DataSource.Catalog(), id: 'MSP', artcc: 'ZMP' })),
      Command.resolve(LoadAirport, Message.FailedLoadAirport({ id: 'MSP', error: 'x' })),
    )
    story(
      update,
      given({ ...initialModel, index: { _tag: 'Ready', index }, airport: { _tag: 'Loading', id: 'MSP' }, deepLink: { airport: 'MSP', scenario: big.id, room: null } }),
      message(Message.CompletedLoadAirport({ airport: msp })),
      Command.expectHas(LoadScenario({ source: DataSource.Catalog(), airportId: 'MSP', scenarioId: big.id })),
      Command.resolve(LoadScenario, Message.FailedLoadScenario({ error: 'x' })),
      Command.resolve(LoadPavement, Message.FailedLoadPavement({ error: 'x' })),
      ...defaultMaps(msp.stars).map((id) => Command.resolve(LoadStarsMap({ artcc: 'ZMP', id }), StarsMessage.FailedLoadMap({ id, error: 'x' }))),
    )
  })

  test('a stale airport result is ignored', () => {
    story(
      update,
      given({ ...initialModel, index: { _tag: 'Ready', index }, airport: { _tag: 'Loading', id: 'FCM' } }),
      message(Message.CompletedLoadAirport({ airport: msp })),
      Command.expectNone(),
      model((m) => {
        expect(m.airport).toEqual({ _tag: 'Loading', id: 'FCM' })
      }),
    )
  })

  test('choosing the empty field clears the aircraft; choosing a scenario fetches it', () => {
    story(
      update,
      given(ready()),
      message(Message.ChangedScenario({ id: '' })),
      Command.expectExact(ReplaceDeepLink({ airport: 'MSP', scenario: null })),
      Command.resolve(ReplaceDeepLink, Message.CompletedReplaceDeepLink()),
      model((m) => {
        expect(worldOf(m)?.aircraft).toHaveLength(0)
        expect(m.log.at(-1)?.text).toBe('Minneapolis ATCT — empty field. Switch on Arrivals, or pick a scenario.')
      }),
      message(Message.ChangedScenario({ id: big.id })),
      Command.expectExact(LoadScenario({ source: DataSource.Catalog(), airportId: 'MSP', scenarioId: big.id })),
      Command.resolve(LoadScenario, Message.FailedLoadScenario({ error: 'offline' })),
      model((m) => {
        expect(m.scenarioLoading).toBeNull()
        expect(m.log[0]?.text).toBe('could not load scenario: offline')
      }),
    )
  })

  test('switching position swaps the rules, logs tips and saves', () => {
    story(
      update,
      given(ready()),
      message(Message.ChangedPosition({ mode: 'tower' })),
      Command.expectExact(SaveSettings({ settings: { ...defaultSettings, mode: 'tower' } })),
      Command.resolve(SaveSettings, Message.CompletedSaveSettings()),
      model((m) => {
        expect(worldOf(m)?.rules.requireLandingClearance).toBe(true)
        expect(m.log[0]?.text).toMatch(/^Local position — try: LUAW/)
        expect(m.stars.view.w).toBe(30)
      }),
      message(Message.ChangedPosition({ mode: 'tracon' })),
      Command.expectExact(SaveSettings({ settings: { ...defaultSettings, mode: 'tracon' } })),
      Command.resolve(SaveSettings, Message.CompletedSaveSettings()),
      model((m) => {
        expect(worldOf(m)?.rules.loadsAirborne).toBe(true)
        expect(worldOf(m)?.rules.radarRangeNm).toBe(150)
        expect(m.log[0]?.text).toMatch(/^Approach position — try: DM 4000 · SPD 210 · DCT [A-Z0-9]+ · FH 240 · CAPP/)
        expect(m.stars.view.w).toBe(80)
      }),
    )
  })
})

describe('clock', () => {
  test('the first tick starts the clock; later ticks step 100 ms each, catching up at most 40 steps', () => {
    story(
      update,
      given(ready()),
      message(Message.Ticked({ now: 1000 })),
      model((m) => {
        expect(m.lastTickAt).toBe(1000)
        expect(worldOf(m)?.tick).toBe(0)
      }),
      ...ticks(1000, 5),
      model((m) => {
        expect(worldOf(m)?.tick).toBe(5)
      }),
      message(Message.Ticked({ now: 1500 + 60_000 })),
      model((m) => {
        expect(worldOf(m)?.tick).toBe(45)
        expect(m.lastTickAt).toBe(61_500)
      }),
      message(Message.Ticked({ now: 61_600 })),
      model((m) => expect(worldOf(m)?.tick).toBe(46)),
    )
  })

  test('rate cycles 1, 2, 4, 8, 1 and pausing stops steps without a catch-up burst', () => {
    story(
      update,
      given(ready()),
      message(Message.ClickedRate()),
      message(Message.ClickedRate()),
      model((m) => expect(m.rate).toBe(4)),
      message(Message.Ticked({ now: 0 })),
      message(Message.Ticked({ now: 100 })),
      model((m) => expect(worldOf(m)?.tick).toBe(4)),
      message(Message.ClickedTogglePlay()),
      message(Message.Ticked({ now: 5000 })),
      message(Message.Ticked({ now: 5100 })),
      model((m) => {
        expect(m.running).toBe(false)
        expect(worldOf(m)?.tick).toBe(4)
      }),
      message(Message.ClickedTogglePlay()),
      message(Message.Ticked({ now: 9000 })),
      message(Message.Ticked({ now: 9100 })),
      model((m) => expect(worldOf(m)?.tick).toBe(8)),
      message(Message.ClickedRate()),
      message(Message.ClickedRate()),
      model((m) => expect(m.rate).toBe(1)),
    )
  })
})

describe('commands and selection', () => {
  test('a typed command selects the aircraft, logs the readback, records the command and keeps history', () => {
    story(
      update,
      given(ready()),
      message(Message.UpdatedCommandText({ value: 'AAL894 PUSH' })),
      message(Message.SubmittedCommand()),
      Command.expectExact(Speak),
      Command.resolve(Speak, Message.CompletedSpeak()),
      model((m) => {
        expect(m.commandText).toBe('')
        expect(m.selected).toBe('AAL894')
        expect(m.log[0]).toMatchObject({ kind: 'pilot', who: 'AAL894', text: 'pushing back off E16' })
        expect(m.log[1]).toMatchObject({ kind: 'atc', text: 'AAL894 PUSH' })
        expect(m.commandLog).toEqual([{ tick: 0, callsign: 'AAL894', command: AtcCommand.Push({ taxiway: null }) }])
        expect(m.history).toEqual(['AAL894 PUSH'])
      }),
      message(Message.UpdatedCommandText({ value: 'PUSH' })),
      message(Message.SubmittedCommand()),
      model((m) => {
        expect(m.log[0]).toMatchObject({ kind: 'err', text: 'unable — not at a gate' })
        expect(m.commandLog).toHaveLength(1)
      }),
      message(Message.PressedHistoryUp()),
      model((m) => expect(m.commandText).toBe('PUSH')),
      message(Message.PressedHistoryUp()),
      model((m) => expect(m.commandText).toBe('AAL894 PUSH')),
      message(Message.PressedHistoryDown()),
      message(Message.PressedHistoryDown()),
      model((m) => expect(m.commandText).toBe('')),
      message(Message.UpdatedCommandText({ value: 'taxi to the runway' })),
      message(Message.SubmittedCommand()),
      model((m) => expect(m.log[0]?.kind).toBe('err')),
      message(Message.IssuedCommand({ callsign: null, command: AtcCommand.Pause() })),
      model((m) => {
        expect(m.running).toBe(false)
        expect(m.commandLog).toHaveLength(2)
      }),
    )
  })

  test('deleting the selected aircraft clears the selection', () => {
    story(
      update,
      given({ ...ready(), selected: 'AAL894' }),
      message(Message.UpdatedCommandText({ value: 'DEL' })),
      message(Message.SubmittedCommand()),
      Command.expectNone(),
      model((m) => {
        expect(m.selected).toBeNull()
        expect(worldOf(m)?.aircraft.some((a) => a.callsign === 'AAL894')).toBe(false)
        expect(m.log[0]?.text).toBe('AAL894 deleted')
      }),
    )
  })

  test('clicking a strip selects and focuses the command box; arrivals toggle schedules the first one', () => {
    story(
      update,
      given(ready()),
      message(Message.ClickedStrip({ callsign: 'DAL2057' })),
      Command.expectExact(FocusCommand),
      Command.resolve(FocusCommand, Message.CompletedFocusCommand()),
      model((m) => expect(m.selected).toBe('DAL2057')),
      message(Message.ClickedArrivals()),
      model((m) => {
        expect(worldOf(m)?.arrivalsEnabled).toBe(true)
        expect(worldOf(m)?.nextArrivalAt).toBe(5)
        expect(m.log[0]?.text).toBe('arrival generator on — MSP fleet mix')
      }),
    )
  })

  test('a click on the scope over an aircraft selects it; a drag pans', () => {
    const m = ready()
    const world = worldOf(m)!
    const a = world.aircraft.find((x) => x.callsign === 'AAL894')!
    const { toCanvas, toWorld } = require('../src/view/viewport') as typeof import('../src/view/viewport')
    const p = toCanvas(m.scope, toWorld(world.graph, a.position))
    story(
      update,
      given(m),
      message(Message.PressedScope({ x: p.x, y: p.y })),
      message(Message.ReleasedScope({ x: p.x, y: p.y })),
      Command.expectExact(FocusCommand),
      Command.resolve(FocusCommand, Message.CompletedFocusCommand()),
      model((n) => expect(n.selected).toBe('AAL894')),
      message(Message.PressedScope({ x: 100, y: 100 })),
      message(Message.MovedScope({ x: 150, y: 120 })),
      message(Message.ReleasedScope({ x: 150, y: 120 })),
      Command.expectNone(),
      model((n) => {
        expect(n.scope.originX).toBeCloseTo(m.scope.originX - 50 / m.scope.scale, 6)
        expect(n.scope.originY).toBeCloseTo(m.scope.originY - 20 / m.scope.scale, 6)
        expect(n.drag).toBeNull()
      }),
      message(Message.WheeledScope({ x: 500, y: 350, deltaY: -1 })),
      model((n) => expect(n.scope.scale).toBeGreaterThan(m.scope.scale)),
      message(Message.ClickedFit()),
      model((n) => expect(n.scope.scale).toBeCloseTo(m.scope.scale, 9)),
      message(Message.ResizedScope({ width: 500, height: 700, devicePixelRatio: 2 })),
      model((n) => {
        expect(n.scope.scale).toBeCloseTo(m.scope.scale / 2, 9)
        expect(n.scope.width).toBe(500)
      }),
    )
  })
})

describe('Local position', () => {
  test('the STARS pane folds: a target click selects and focuses; a failed map logs', () => {
    const m = ready()
    story(
      update,
      given(m),
      message(Message.GotStars({ message: StarsMessage.FailedLoadMap({ id: 'abc', error: 'HTTP 404' }) })),
      Command.expectNone(),
      model((n) => expect(n.log[0]?.text).toBe('map abc: HTTP 404')),
      message(Message.GotStars({ message: StarsMessage.ClickedRangeOut() })),
      model((n) => expect(n.stars.view.w).toBe(46)),
      message(Message.ClickedPane({ view: 'stars' })),
      Command.expectExact(SaveSettings({ settings: { ...defaultSettings, view: 'stars' } })),
      Command.resolve(SaveSettings, Message.CompletedSaveSettings()),
      model((n) => expect(n.settings.view).toBe('stars')),
    )
  })
})

describe('settings', () => {
  test('saving trims and defaults fields, logs the AI state, and reloads the index when the proxy changes', () => {
    story(
      update,
      given(ready()),
      message(Message.ClickedSettings()),
      Command.expectExact(LoadBrowserVoices),
      Command.resolve(LoadBrowserVoices, Message.CompletedLoadBrowserVoices({ voices: [{ name: 'Samantha', lang: 'en-US' }] })),
      model((m) => {
        expect(m.dialog).toBe('settings')
        expect(m.browserVoices).toEqual([{ name: 'Samantha', lang: 'en-US' }])
      }),
      message(Message.UpdatedDraft({ draft: { ...defaultSettings, key: ' sk-1 ', model: '  ', proxy: ' https://p/?url= ' } })),
      message(Message.ClickedSaveSettings()),
      Command.expectExact(
        SaveSettings({ settings: { ...defaultSettings, key: 'sk-1', proxy: 'https://p/?url=' } }),
        LoadIndex({ source: DataSource.Live({ proxy: 'https://p/?url=' }) }),
      ),
      Command.resolve(SaveSettings, Message.CompletedSaveSettings()),
      Command.resolve(LoadIndex, Message.FailedLoadIndex({ error: 'no proxy' })),
      model((m) => {
        expect(m.dialog).toBe('none')
        expect(m.settings.model).toBe(defaultSettings.model)
        expect(m.log[0]?.text).toBe(`plain-English commands on via OpenRouter (${defaultSettings.model})`)
        expect(m.index).toEqual({ _tag: 'Failed', error: 'no proxy' })
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
