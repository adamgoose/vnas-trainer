/**
 * init and update. Data loading is a chain of Commands (settings, deep link,
 * index, airport, scenario, pavement); the simulation advances on Ticked; every
 * SimEvent becomes a log line here.
 */
import { Option } from 'effect'
import { Command, Update } from 'foldkit'
import { evo } from 'foldkit/struct'

import { BlurCommand, FocusCommand, LoadAirport, LoadIndex, LoadPavement, LoadScenario, LoadSettings, ReadDeepLink, ReplaceDeepLink, SaveSettings } from './commands'
import { Message } from './message'
import { AirportLoad, type AirportInfo, IndexLoad, type LogLine, type Model, Pavement, infoOf, initialModel, worldOf } from './model'
import type { Services } from './subscriptions'
import { TICK_MS } from './subscriptions'
import type { AirportFile, CatalogIndex } from '../domain/catalog'
import { type AtcCommand, executeCommand, parseCommandLine } from '../domain/commands'
import { written } from '../domain/phrase'
import { MAX_STEPS_PER_TICK, stepWorldTimes } from '../domain/physics'
import { loadScenario } from '../domain/scenario'
import { SimEvent, type World, makeWorld } from '../domain/world'
import { type PositionMode, positionFor } from '../positions'
import { StarsOut, starsInit, starsUpdate } from '../positions/local/stars'
import { type Settings, defaultSettings } from '../services/settings'
import { sourceForProxy } from '../services/vnasData'
import { BUTTON_IN, BUTTON_OUT, WHEEL_IN, WHEEL_OUT, fit, hitTest, pan, resize, zoomAt, zoomCentre } from '../view/viewport'

export type Return = Update.Return<Model, Message, Services>

export const WORLD_SEED = 20260906

export const rulesFor = (mode: PositionMode) => positionFor(mode).rules
export const positionLabel = (mode: PositionMode): string => positionFor(mode).label
export const positionTips = (mode: PositionMode, world: World): string => positionFor(mode).tips(world)

export const aiEnabled = (settings: Settings): boolean => settings.key !== '' && settings.model !== ''

// INIT

export const init = (): Return => ({ model: initialModel, commands: [LoadSettings()] })

// HELPERS

/**
 * Replace the World. A plain literal, not `AirportLoad.Ready(...)`: the tagged-union
 * constructors decode through the Schema and rebuild the whole payload, which on
 * every tick would copy the graph and every aircraft and defeat the view memos.
 */
const withWorld = (model: Model, world: World): Model =>
  model.airport._tag === 'Ready' ? { ...model, airport: { _tag: 'Ready', info: model.airport.info, world } } : model

const pushLog = (model: Model, kind: LogLine['kind'], who: string | null, text: string): Model =>
  evo(model, { log: (log) => [{ kind, time: worldOf(model)?.simTime ?? 0, who, text }, ...log].slice(0, 140) })

export const applyEvents = (model: Model, events: ReadonlyArray<SimEvent>): Model =>
  events.reduce(
    (m, event) =>
      SimEvent.match(event, {
        PilotSaid: ({ callsign, phrase }) => pushLog(m, 'pilot', callsign, written(phrase)),
        SystemNote: ({ text }) => pushLog(m, 'sys', null, text),
        Removed: ({ callsign, text }) => pushLog(evo(m, { selected: (s) => (s === callsign ? null : s) }), 'sys', null, text),
        SetRunning: ({ running }) => evo(m, { running: () => running, lastTickAt: () => null }),
        SetRate: ({ rate }) => evo(m, { rate: () => rate }),
      }),
    model,
  )

const runCommand = (model: Model, callsign: string | null, command: AtcCommand): Model => {
  const world = worldOf(model)
  if (world === null) {
    return model
  }
  const result = executeCommand(world, callsign, command)
  if ('error' in result) {
    return pushLog(model, 'err', callsign, `unable — ${result.error}`)
  }
  const recorded = evo(withWorld(model, result.world), { commandLog: (log) => [...log, { tick: world.tick, callsign, command }] })
  return applyEvents(recorded, result.events)
}

const airportInfo = (airport: AirportFile): AirportInfo => ({
  id: airport.id,
  artcc: airport.artcc,
  name: airport.name,
  asdex: airport.asdex,
  twrmap: airport.twrmap,
  stars: airport.stars,
  scenarios: airport.scen.map((s) => ({ id: s.id, name: s.name, count: s.ac.length })),
})

const findArtcc = (index: CatalogIndex, airportId: string) => index.artccs.find((a) => a.airports.some((p) => p.id === airportId))

const startLoadingAirport = (model: Model, id: string): Return => {
  if (model.index._tag !== 'Ready') {
    return { model }
  }
  const artcc = findArtcc(model.index.index, id)
  if (artcc === undefined) {
    return { model: evo(model, { airport: () => AirportLoad.Failed({ id, error: `unknown airport ${id}` }) }) }
  }
  return {
    model: evo(model, { airport: () => AirportLoad.Loading({ id }), pavement: () => Pavement.None(), selected: () => null }),
    commands: [LoadAirport({ source: sourceForProxy(model.settings.proxy), id, artcc: artcc.id })],
  }
}

/** Apply a loaded (or empty) scenario: fresh log, selection and command log, hash updated. */
const applyScenario = (model: Model, scenarioId: string | null, scenario: Parameters<typeof loadScenario>[1]): Return => {
  const world = worldOf(model)
  const info = infoOf(model)
  if (world === null || info === null) {
    return { model }
  }
  const loaded = loadScenario(world, scenario)
  const fresh = evo(withWorld(model, loaded.world), {
    log: () => [],
    selected: () => null,
    commandLog: () => [],
    scenarioLoading: () => null,
    lastTickAt: () => null,
  })
  const announced = applyEvents(fresh, loaded.events)
  const tips =
    Object.keys(loaded.world.graph.taxiways).length > 0
      ? `${positionLabel(model.settings.mode)} position. Select an aircraft, then try: ${positionTips(model.settings.mode, loaded.world)}`
      : 'This training map has runways only — no taxiways, so PUSH and TAXI are unavailable here. Try: LUAW · CTO · Arrivals.'
  return {
    model: pushLog(announced, 'sys', null, tips),
    commands: [ReplaceDeepLink({ airport: info.id, scenario: scenarioId })],
  }
}

const selectScenario = (model: Model, scenarioId: string | null): Return => {
  const info = infoOf(model)
  if (info === null) {
    return { model }
  }
  if (scenarioId === null || !info.scenarios.some((s) => s.id === scenarioId)) {
    return applyScenario(model, null, null)
  }
  return {
    model: evo(model, { scenarioLoading: () => scenarioId }),
    commands: [LoadScenario({ source: sourceForProxy(model.settings.proxy), airportId: info.id, scenarioId })],
  }
}

const cycleRate = (rate: number): number => (rate >= 8 ? 1 : rate * 2)

/** The STARS Submodel: its messages fold into the parent, its OutMessages select targets or log. */
const foldStars = (artcc: string) =>
  Update.foldChild({
    update: (stars: Model['stars'], input: Parameters<typeof starsUpdate>[2]) => starsUpdate(stars, artcc, input),
    read: (model: Model) => Option.some(model.stars),
    write: (model: Model, stars: Model['stars']) => evo(model, { stars: () => stars }),
    toParentMessage: (message) => Message.GotStars({ message }),
    foldOutMessage: (out: StarsOut) => (model: Model) =>
      StarsOut.match<Return>(out, {
        SelectedTarget: ({ callsign }) => ({ model: evo(model, { selected: () => callsign }), commands: [FocusCommand()] }),
        Noted: ({ text }) => ({ model: pushLog(model, 'sys', null, text) }),
      }),
  })

// UPDATE

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    CompletedLoadSettings: ({ settings }) => ({
      model: evo(model, { settings: () => settings, draft: () => settings }),
      commands: [ReadDeepLink()],
    }),

    CompletedReadDeepLink: ({ airport, scenario }) => ({
      model: evo(model, { deepLink: () => ({ airport, scenario }), index: () => IndexLoad.Loading() }),
      commands: [LoadIndex({ source: sourceForProxy(model.settings.proxy) })],
    }),

    ChangedDeepLink: ({ airport, scenario }) => {
      if (airport === null) {
        return { model }
      }
      const withLink = evo(model, { deepLink: () => ({ airport, scenario }) })
      const info = infoOf(model)
      if (info !== null && info.id === airport) {
        return selectScenario(withLink, scenario)
      }
      return startLoadingAirport(withLink, airport)
    },

    CompletedLoadIndex: ({ index }) => {
      const ready = evo(model, { index: () => IndexLoad.Ready({ index }) })
      const linked = model.deepLink.airport
      const known = linked !== null && findArtcc(index, linked) !== undefined ? linked : null
      const busiest = index.artccs.flatMap((a) => a.airports).reduce<{ id: string; n: number } | null>((best, p) => (best === null || p.n > best.n ? p : best), null)
      const chosen = known ?? busiest?.id ?? null
      if (chosen === null) {
        return { model: { ...ready, index: IndexLoad.Failed({ error: 'the catalog has no airports' }) } }
      }
      return startLoadingAirport(ready, chosen)
    },

    FailedLoadIndex: ({ error }) => ({ model: evo(model, { index: () => IndexLoad.Failed({ error }) }) }),

    CompletedLoadAirport: ({ airport }) => {
      if (model.airport._tag !== 'Loading' || model.airport.id !== airport.id) {
        return { model }
      }
      const world = makeWorld(airport, rulesFor(model.settings.mode), WORLD_SEED)
      const info = airportInfo(airport)
      const pavementId = airport.asdex ?? airport.twrmap
      const radar = starsInit(model.stars, airport.artcc, airport.stars)
      const fitted: Model = {
        ...model,
        airport: { _tag: 'Ready', info, world },
        pavement: pavementId === null ? Pavement.None() : Pavement.Loading({ id: pavementId }),
        scope: fit(world.graph, { ...model.scope, fitted: false }),
        stars: radar.model,
      }
      const wanted = model.deepLink.airport === airport.id ? model.deepLink.scenario : null
      const scenarioId = wanted !== null && info.scenarios.some((s) => s.id === wanted) ? wanted : (info.scenarios[0]?.id ?? null)
      const next = selectScenario(fitted, scenarioId)
      return {
        model: next.model,
        commands: [
          ...(next.commands ?? []),
          ...(pavementId === null ? [] : [LoadPavement({ artcc: airport.artcc, id: pavementId, asdex: airport.asdex !== null })]),
          ...Command.mapMessages(radar.commands, (message) => Message.GotStars({ message })),
        ],
      }
    },

    FailedLoadAirport: ({ id, error }) => ({ model: evo(model, { airport: () => AirportLoad.Failed({ id, error }) }) }),

    CompletedLoadScenario: ({ airportId, scenario }) => {
      const info = infoOf(model)
      if (info === null || info.id !== airportId || model.scenarioLoading !== scenario.id) {
        return { model }
      }
      return applyScenario(model, scenario.id, scenario)
    },

    FailedLoadScenario: ({ error }) => ({ model: pushLog(evo(model, { scenarioLoading: () => null }), 'err', null, `could not load scenario: ${error}`) }),

    CompletedLoadPavement: ({ id, asdex }) => ({
      model: model.pavement._tag === 'Loading' && model.pavement.id === id ? evo(model, { pavement: () => Pavement.Ready({ id, asdex }) }) : model,
    }),

    FailedLoadPavement: ({ error }) => ({ model: pushLog(evo(model, { pavement: () => Pavement.Failed({ error }) }), 'sys', null, `no pavement map (${error})`) }),

    CompletedSaveSettings: () => ({ model }),
    CompletedFocusCommand: () => ({ model }),
    CompletedBlurCommand: () => ({ model }),
    CompletedReplaceDeepLink: () => ({ model }),

    Ticked: ({ now }) => {
      const world = worldOf(model)
      if (world === null) {
        return { model }
      }
      if (model.lastTickAt === null) {
        return { model: evo(model, { lastTickAt: () => now }) }
      }
      const n = Math.min(MAX_STEPS_PER_TICK, Math.floor((now - model.lastTickAt) / TICK_MS))
      if (n <= 0) {
        return { model }
      }
      const clocked = evo(model, { lastTickAt: (last) => (last ?? now) + n * TICK_MS })
      if (!model.running) {
        return { model: clocked }
      }
      const stepped = stepWorldTimes(world, n * model.rate)
      return { model: applyEvents(withWorld(clocked, stepped.world), stepped.events) }
    },

    ChangedPosition: ({ mode }) => {
      const settings = { ...model.settings, mode }
      const world = worldOf(model)
      const switched = evo(model, { settings: () => settings, draft: () => settings })
      const withRules = world === null ? switched : withWorld(switched, { ...world, rules: rulesFor(mode) })
      const logged = world === null ? withRules : pushLog(withRules, 'sys', null, `${positionLabel(mode)} position — try: ${positionTips(mode, world)}`)
      return { model: logged, commands: [SaveSettings({ settings })] }
    },

    ChangedArtcc: ({ id }) => {
      if (model.index._tag !== 'Ready') {
        return { model }
      }
      const first = model.index.index.artccs.find((a) => a.id === id)?.airports[0]
      return first === undefined ? { model } : startLoadingAirport(model, first.id)
    },

    ChangedAirport: ({ id }) => startLoadingAirport(model, id),

    ChangedScenario: ({ id }) => selectScenario(model, id === '' ? null : id),

    ClickedTogglePlay: () => ({ model: evo(model, { running: (r) => !r, lastTickAt: () => null }) }),

    ClickedRate: () => ({ model: evo(model, { rate: cycleRate }) }),

    ClickedArrivals: () => {
      const world = worldOf(model)
      if (world === null) {
        return { model }
      }
      const enabled = !world.arrivalsEnabled
      const next = withWorld(model, { ...world, arrivalsEnabled: enabled, nextArrivalAt: world.simTime + 5 })
      return {
        model: pushLog(
          next,
          'sys',
          null,
          enabled ? `arrival generator on — ${world.airport.fleet.length > 0 ? `${world.airport.id} fleet mix` : 'generic GA mix'}` : 'arrival generator off',
        ),
      }
    },

    ResizedScope: ({ width, height, devicePixelRatio }) => {
      const world = worldOf(model)
      const sized = evo(model, { devicePixelRatio: () => devicePixelRatio, scope: (scope) => (scope.fitted ? resize(scope, width, height) : { ...scope, width, height }) })
      return { model: world !== null && !model.scope.fitted ? evo(sized, { scope: (scope) => fit(world.graph, scope) }) : sized }
    },

    WheeledScope: ({ x, y, deltaY }) => {
      const world = worldOf(model)
      return { model: world === null ? model : evo(model, { scope: (scope) => zoomAt(world.graph, scope, x, y, deltaY > 0 ? WHEEL_OUT : WHEEL_IN) }) }
    },

    PressedScope: ({ x, y }) => ({
      model: evo(model, { drag: () => ({ startX: x, startY: y, originX: model.scope.originX, originY: model.scope.originY, moved: false }) }),
    }),

    MovedScope: ({ x, y }) => {
      const drag = model.drag
      if (drag === null) {
        return { model }
      }
      const moved = drag.moved || Math.hypot(x - drag.startX, y - drag.startY) > 3
      return {
        model: evo(model, {
          drag: () => ({ ...drag, moved }),
          scope: (scope) => pan(scope, drag.originX, drag.originY, x - drag.startX, y - drag.startY),
        }),
      }
    },

    ReleasedScope: ({ x, y }) => {
      const drag = model.drag
      const world = worldOf(model)
      const released = evo(model, { drag: () => null })
      if (drag === null || drag.moved || world === null) {
        return { model: released }
      }
      const hit = hitTest(world.graph, model.scope, x, y, world.aircraft.filter((a) => a.delay <= 0), (a) => a.position)
      return hit === null ? { model: released } : { model: evo(released, { selected: () => hit.callsign }), commands: [FocusCommand()] }
    },

    ClickedZoomIn: () => {
      const world = worldOf(model)
      return { model: world === null ? model : evo(model, { scope: (scope) => zoomCentre(world.graph, scope, BUTTON_IN) }) }
    },

    ClickedZoomOut: () => {
      const world = worldOf(model)
      return { model: world === null ? model : evo(model, { scope: (scope) => zoomCentre(world.graph, scope, BUTTON_OUT) }) }
    },

    ClickedFit: () => {
      const world = worldOf(model)
      return { model: world === null ? model : evo(model, { scope: (scope) => fit(world.graph, scope) }) }
    },

    ClickedStrip: ({ callsign }) => ({ model: evo(model, { selected: () => callsign }), commands: [FocusCommand()] }),

    UpdatedCommandText: ({ value }) => ({ model: evo(model, { commandText: () => value }) }),

    SubmittedCommand: () => {
      const world = worldOf(model)
      const text = model.commandText.trim()
      if (world === null || text === '') {
        return { model: evo(model, { commandText: () => '' }) }
      }
      const entered = evo(model, { commandText: () => '', history: (h) => [text, ...h].slice(0, 50), historyIndex: () => -1 })
      const parsed = parseCommandLine(world, model.selected, text)
      if (parsed._tag === 'Empty') {
        return { model: entered }
      }
      if (parsed._tag === 'Unknown') {
        return {
          model: pushLog(
            entered,
            'err',
            null,
            aiEnabled(model.settings) ? 'plain-English translation arrives in Phase 5' : 'not a command — set an OpenRouter key in Settings for plain English',
          ),
        }
      }
      const logged = pushLog(evo(entered, { selected: (s) => parsed.callsign ?? s }), 'atc', null, text)
      if (parsed._tag === 'Invalid') {
        return { model: pushLog(logged, 'err', parsed.callsign, `unable — ${parsed.error}`) }
      }
      return { model: runCommand(logged, parsed.callsign, parsed.command) }
    },

    PressedHistoryUp: () => {
      const i = model.historyIndex + 1
      const text = model.history[i]
      return text === undefined ? { model } : { model: evo(model, { historyIndex: () => i, commandText: () => text }) }
    },

    PressedHistoryDown: () => {
      const i = model.historyIndex - 1
      return i < 0
        ? { model: evo(model, { historyIndex: () => -1, commandText: () => '' }) }
        : { model: evo(model, { historyIndex: () => i, commandText: () => model.history[i] ?? '' }) }
    },

    PressedSlash: () => ({ model, commands: [FocusCommand()] }),
    PressedEscape: () => ({ model, commands: [BlurCommand()] }),

    IssuedCommand: ({ callsign, command }) => ({ model: runCommand(model, callsign, command) }),

    ClickedSpeaker: () => {
      const settings = { ...model.settings, tts: !model.settings.tts }
      return {
        model: pushLog(evo(model, { settings: () => settings }), 'sys', null, settings.tts ? 'pilot voices on' : 'pilot voices off'),
        commands: [SaveSettings({ settings })],
      }
    },

    ClickedHelp: () => ({ model: evo(model, { dialog: () => 'help' }) }),

    ClickedSettings: () => ({ model: evo(model, { dialog: () => 'settings', draft: () => model.settings, settingsStatus: () => '' }) }),

    ClosedDialog: () => ({ model: evo(model, { dialog: () => 'none' }) }),

    UpdatedDraft: ({ draft }) => ({ model: evo(model, { draft: () => draft }) }),

    ClickedPane: ({ view }) => {
      const settings = { ...model.settings, view }
      return { model: evo(model, { settings: () => settings, draft: () => settings }), commands: [SaveSettings({ settings })] }
    },

    GotStars: ({ message }) => {
      const info = infoOf(model)
      return foldStars(info?.artcc ?? '')(model, { message, world: worldOf(model) })
    },

    ClickedSaveSettings: () => {
      const d = model.draft
      const settings: Settings = {
        ...d,
        key: d.key.trim(),
        model: d.model.trim() || defaultSettings.model,
        audioModel: d.audioModel.trim() || defaultSettings.audioModel,
        ttsModel: d.ttsModel.trim() || defaultSettings.ttsModel,
        proxy: d.proxy.trim(),
      }
      const saved = evo(model, { settings: () => settings, draft: () => settings, dialog: () => 'none' })
      const logged = pushLog(
        saved,
        'sys',
        null,
        aiEnabled(settings) ? `plain-English commands on via OpenRouter (${settings.model})` : 'plain-English commands off — command syntax only',
      )
      const proxyChanged = settings.proxy !== model.settings.proxy
      return {
        model: proxyChanged ? evo(logged, { index: () => IndexLoad.Loading(), airport: () => AirportLoad.Idle() }) : logged,
        commands: [SaveSettings({ settings }), ...(proxyChanged ? [LoadIndex({ source: sourceForProxy(settings.proxy) })] : [])],
      }
    },
  })
