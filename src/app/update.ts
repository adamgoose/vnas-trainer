/**
 * init and update. Data loading is a chain of Commands (settings, deep link,
 * index, airport, scenario, pavement); the simulation advances on Ticked; every
 * SimEvent becomes a log line here and, for pilot lines, a Speak command.
 * Plain-English transmissions go to OpenRouter and come back as commands.
 */
import { Option } from 'effect'
import { Command, Update } from 'foldkit'
import { evo } from 'foldkit/struct'

import {
  BlurCommand,
  FocusCommand,
  HostRoom,
  JoinRoom,
  LeaveRoom,
  LoadAirport,
  LoadBrowserVoices,
  LoadIndex,
  LoadModels,
  LoadPavement,
  LoadScenario,
  LoadSettings,
  ProbeRecognition,
  ReadDeepLink,
  ReplaceDeepLink,
  SaveSettings,
  SendSession,
  Speak,
  StartRecognition,
  StartRecording,
  StopRecognition,
  StopRecording,
  StopSpeaking,
  TEST_VOICE_SAMPLE,
  TestKey,
  TestVoice,
  TranslateAudio,
  TranslateText,
} from './commands'
import { Message } from './message'
import { AirportLoad, type AirportInfo, IndexLoad, type LogLine, type Model, Pavement, infoOf, initialModel, initialSession, isGuest, isHost, worldOf } from './model'
import type { Services } from './subscriptions'
import { TICK_MS } from './subscriptions'
import type { AirportFile, CatalogIndex } from '../domain/catalog'
import { type AtcCommand, executeCommand, parseCommandLine } from '../domain/commands'
import { type Phrase, spoken, spokenCallsign, spokenFreeText, written } from '../domain/phrase'
import { MAX_STEPS_PER_TICK, stepWorldTimes } from '../domain/physics'
import { type Translation, buildPrompt } from '../domain/prompt'
import { loadScenario } from '../domain/scenario'
import { SessionControl, SessionEvent, type Snapshot, isRoomCode, normaliseRoomCode } from '../domain/session'
import { SimEvent, type World, findAircraft, makeWorld, matchCallsign } from '../domain/world'
import { type PositionMode, positionFor } from '../positions'
import { radialAt } from './radial'
import { StarsOut, rangeView, starsInit, starsUpdate } from '../positions/local/stars'
import { type TurnServer } from '../services/session'
import { MAX_SPLIT, MAX_TAG_SIZE, MIN_SPLIT, MIN_TAG_SIZE, type Settings, defaultSettings } from '../services/settings'
import { sourceForProxy } from '../services/vnasData'
import { BUTTON_IN, BUTTON_OUT, WHEEL_IN, WHEEL_OUT, fit, hitTest, pan, resize, zoomAt, zoomCentre } from '../view/viewport'

export type Return = Update.Return<Model, Message, Services>
type Commands = NonNullable<Return['commands']>

export const WORLD_SEED = 20260906

/**
 * A throttled tab catches up at most this much wall-clock per tick; anything
 * older (a tab left in the background for an hour) is dropped rather than
 * fast-forwarded, which the legacy loop would have done at 40 steps per tick.
 */
export const MAX_BACKLOG_MS = 4000

export const rulesFor = (mode: PositionMode) => positionFor(mode).rules
export const positionLabel = (mode: PositionMode): string => positionFor(mode).label
export const positionTips = (mode: PositionMode, world: World): string => positionFor(mode).tips(world)

export const aiEnabled = (settings: Settings): boolean => settings.key !== '' && settings.model !== ''

/** OpenRouter keys start with `sk-or-`; anything else in the key field is almost certainly a paste mistake. */
export const looksLikeOpenRouterKey = (key: string): boolean => /^sk-or-/.test(key)

const keyWarning = (key: string): string | null =>
  key !== '' && !looksLikeOpenRouterKey(key) ? `that doesn't look like an OpenRouter key (they start with sk-or-); check the key field` : null

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

/** A Speak command for the current voice settings; `raw` text already ends the way a pilot would. */
const speakCommand = (settings: Settings, callsign: string, text: string) =>
  Speak({
    callsign,
    text,
    engine: settings.ttsEngine,
    key: settings.key,
    model: settings.ttsModel,
    providerVoice: settings.ttsVoice,
    browserVoice: settings.voice,
    radio: settings.radio,
  })

/** What the voice says for a sim pilot line: the phrase, then the callsign unless the phrase already carries it. */
export const utteranceFor = (callsign: string, phrase: Phrase): string =>
  phrase.some((t) => t._tag === 'Callsign') ? spoken(phrase) : `${spoken(phrase)}, ${spokenCallsign(callsign)}`

export type Applied = Readonly<{ model: Model; commands: Commands }>

export const applyEvents = (model: Model, events: ReadonlyArray<SimEvent>, options: Readonly<{ quiet?: boolean }> = {}): Applied =>
  events.reduce<Applied>(
    ({ model: m, commands }, event) =>
      SimEvent.match<Applied>(event, {
        PilotSaid: ({ callsign, phrase }) =>
          options.quiet === true
            ? { model: m, commands }
            : {
                model: pushLog(m, 'pilot', callsign, written(phrase)),
                commands: m.settings.tts ? [...commands, speakCommand(m.settings, callsign, utteranceFor(callsign, phrase))] : commands,
              },
        SystemNote: ({ text }) => ({ model: pushLog(m, 'sys', null, text), commands }),
        Removed: ({ callsign, text }) => ({ model: pushLog(evo(m, { selected: (s) => (s === callsign ? null : s) }), 'sys', null, text), commands }),
        SetRunning: ({ running }) => ({ model: evo(m, { running: () => running, lastTickAt: () => null }), commands }),
        SetRate: ({ rate }) => ({ model: evo(m, { rate: () => rate }), commands }),
      }),
    { model, commands: [] },
  )

type Ran = Readonly<{ model: Model; commands: Commands; ok: boolean }>

/** Execute a command here. On the host the executed command is also broadcast so every peer applies it. */
const runCommand = (model: Model, callsign: string | null, command: AtcCommand, quiet = false, said: string | null = null): Ran => {
  const world = worldOf(model)
  if (world === null) {
    return { model, commands: [], ok: false }
  }
  const result = executeCommand(world, callsign, command)
  if ('error' in result) {
    return { model: pushLog(model, 'err', callsign, `unable — ${result.error}`), commands: [], ok: false }
  }
  const recorded = evo(withWorld(model, result.world), {
    commandLog: (log) => [...log, { tick: world.tick, callsign, command }],
    selected: (s) => (command._tag === 'Delete' && s === callsign ? null : s),
  })
  const applied = applyEvents(recorded, result.events, { quiet })
  return { model: applied.model, commands: [...applied.commands, ...broadcast(model, SessionEvent.Commanded({ callsign, command, said }))], ok: true }
}

/**
 * Where a command goes: a guest asks the host and applies it when the host's
 * broadcast comes back; the host and a solo player execute it here.
 */
const dispatchCommand = (model: Model, callsign: string | null, command: AtcCommand, said: string | null, quiet = false): Ran =>
  isGuest(model)
    ? { model, commands: [SendSession({ event: SessionEvent.RequestedCommand({ callsign, command, said }), target: model.session.hostId })], ok: true }
    : runCommand(model, callsign, command, quiet, said)

/**
 * A command line, typed or picked from the radial menu: into the history, parsed
 * (a leading callsign selects), logged as the controller's line, then dispatched;
 * text that is not a command goes to the AI translator when a key is set.
 */
const submitLine = (model: Model, text: string): Return => {
  const world = worldOf(model)
  if (world === null || text === '') {
    return { model }
  }
  const entered = evo(model, { history: (h) => [text, ...h].slice(0, 50), historyIndex: () => -1 })
  const parsed = parseCommandLine(world, model.selected, text)
  if (parsed._tag === 'Empty') {
    return { model: entered }
  }
  if (parsed._tag === 'Unknown') {
    if (!aiEnabled(model.settings)) {
      return { model: pushLog(entered, 'err', null, 'unrecognised command — see Commands, or add an OpenRouter key in Settings for plain English') }
    }
    const prompt = promptFor(model, world, false)
    return {
      model: evo(entered, { pendingAi: () => 'translating…' }),
      commands: [TranslateText({ key: model.settings.key, model: model.settings.model, system: prompt.system, user: prompt.user, said: text })],
    }
  }
  const selected = evo(entered, { selected: (s) => parsed.callsign ?? s })
  if (parsed._tag === 'Invalid') {
    return { model: pushLog(pushLog(selected, 'atc', null, text), 'err', parsed.callsign, `unable — ${parsed.error}`) }
  }
  const ran = dispatchCommand(isGuest(selected) ? selected : pushLog(selected, 'atc', null, text), parsed.callsign, parsed.command, text)
  return { model: ran.model, commands: ran.commands }
}

/** A setting changed outside the dialog: apply it, keep the dialog's draft in step, persist. */
/**
 * Which map the ground scope draws as pavement: the ASDE-X map where there is
 * one, unless the user prefers the tower-cab artwork and the airport has that
 * too; airports without ASDE-X always get their cab map.
 */
export const pavementFor = (asdex: string | null, twrmap: string | null, cabMap: boolean): Readonly<{ id: string; asdex: boolean }> | null =>
  asdex !== null && !(cabMap && twrmap !== null) ? { id: asdex, asdex: true } : twrmap !== null ? { id: twrmap, asdex: false } : null

const saveSettings = (model: Model, settings: Settings): Return => ({
  model: evo(model, { settings: () => settings, draft: () => settings }),
  commands: [SaveSettings({ settings })],
})

// SESSION HELPERS

const turnOf = (settings: Settings): TurnServer | null =>
  settings.turnUrl.trim() === '' ? null : { url: settings.turnUrl.trim(), username: settings.turnUsername, credential: settings.turnCredential }

const broadcast = (model: Model, event: SessionEvent): Commands => (isHost(model) ? [SendSession({ event, target: null })] : [])

const snapshotOf = (model: Model): Snapshot | null => {
  const world = worldOf(model)
  const info = infoOf(model)
  if (world === null || info === null) {
    return null
  }
  return { airportId: info.id, artcc: info.artcc, scenarioId: world.scenario?.id ?? null, world, running: model.running, rate: model.rate, mode: model.settings.mode }
}

const withSession = (model: Model, patch: Partial<Model['session']>): Model => evo(model, { session: (session) => ({ ...session, ...patch }) })

/** Session-wide state that is not an aircraft command; applied the same way on every peer. */
const applyControl = (model: Model, control: SessionControl): Return =>
  SessionControl.match<Return>(control, {
    SetRunning: ({ running }) => ({ model: evo(model, { running: () => running, lastTickAt: () => null }) }),
    SetRate: ({ rate }) => ({ model: evo(model, { rate: () => rate }) }),
    SetArrivals: ({ enabled }) => {
      const world = worldOf(model)
      if (world === null) {
        return { model }
      }
      const next = withWorld(model, { ...world, arrivalsEnabled: enabled, nextArrivalAt: world.simTime + 5 })
      return {
        model: pushLog(next, 'sys', null, enabled ? `arrival generator on — ${world.airport.fleet.length > 0 ? `${world.airport.id} fleet mix` : 'generic GA mix'}` : 'arrival generator off'),
      }
    },
    SetPosition: ({ mode }) => {
      const settings = { ...model.settings, mode }
      const world = worldOf(model)
      const switched = evo(model, { settings: () => settings, draft: () => settings })
      const withRules = world === null ? switched : withWorld(switched, { ...world, rules: rulesFor(mode) })
      const ranged = evo(withRules, { stars: (stars) => ({ ...stars, view: rangeView(positionFor(mode).scopeRangeNm) }) })
      const logged = world === null ? ranged : pushLog(ranged, 'sys', null, `${positionLabel(mode)} position — try: ${positionTips(mode, world)}`)
      return { model: logged, commands: [SaveSettings({ settings })] }
    },
  })

/** A control from the UI: guests ask the host; the host applies and broadcasts. */
const control = (model: Model, c: SessionControl): Return => {
  if (isGuest(model)) {
    return { model, commands: [SendSession({ event: SessionEvent.RequestedControl({ control: c }), target: model.session.hostId })] }
  }
  const applied = applyControl(model, c)
  return { model: applied.model, commands: [...(applied.commands ?? []), ...broadcast(model, SessionEvent.Controlled({ control: c }))] }
}

/** A guest takes the host's picture: the World, clock state and position; the log starts over. */
const applySnapshot = (model: Model, snapshot: Snapshot, hostId: string): Return => {
  const info = infoOf(model)
  if (info === null || info.id !== snapshot.airportId) {
    return {
      model: withSession(evo(model, { airport: () => AirportLoad.Loading({ id: snapshot.airportId }), pavement: () => Pavement.None(), selected: () => null }), { pendingSnapshot: snapshot, hostId }),
      commands: [LoadAirport({ source: sourceForProxy(model.settings.proxy), id: snapshot.airportId, artcc: snapshot.artcc })],
    }
  }
  const settings = { ...model.settings, mode: snapshot.mode }
  const taken = evo(withWorld(model, snapshot.world), {
    running: () => snapshot.running,
    rate: () => snapshot.rate,
    settings: () => settings,
    draft: () => settings,
    log: () => [],
    commandLog: () => [],
    selected: () => null,
    scenarioLoading: () => null,
    lastTickAt: () => null,
  })
  return {
    model: pushLog(withSession(taken, { pendingSnapshot: null, hostId, status: 'connected' }), 'sys', null, `joined session ${model.session.room ?? ''} — following ${snapshot.airportId}`),
    commands: [SaveSettings({ settings })],
  }
}

/** What a peer sent us, by our role. */
const receiveSession = (model: Model, peerId: string, event: SessionEvent): Return =>
  SessionEvent.match<Return>(event, {
    Snapshot: ({ snapshot }) => (isGuest(model) ? applySnapshot(model, snapshot, peerId) : { model }),
    Stepped: ({ steps }) => {
      const world = worldOf(model)
      if (!isGuest(model) || world === null || peerId !== model.session.hostId) {
        return { model }
      }
      const stepped = stepWorldTimes(world, steps)
      return applyEvents(withWorld(model, stepped.world), stepped.events)
    },
    /** A peer's command never moves this browser's selection: the user may be mid-way through typing for another aircraft. */
    Commanded: ({ callsign, command, said }) => {
      if (!isGuest(model) || peerId !== model.session.hostId) {
        return { model }
      }
      const logged = said === null ? model : pushLog(model, 'atc', null, said)
      const ran = runCommand(logged, callsign, command)
      return { model: ran.model, commands: ran.commands }
    },
    Controlled: ({ control: c }) => (isGuest(model) && peerId === model.session.hostId ? applyControl(model, c) : { model }),
    RequestedCommand: ({ callsign, command, said }) => {
      if (!isHost(model)) {
        return { model }
      }
      const logged = said === null ? model : pushLog(model, 'atc', null, said)
      const ran = runCommand(logged, callsign, command, false, said)
      return { model: ran.model, commands: ran.commands }
    },
    RequestedControl: ({ control: c }) => (isHost(model) ? control(model, c) : { model }),
    RequestedScenario: ({ scenarioId }) => (isHost(model) ? selectScenario(model, scenarioId) : { model }),
  })

const airportInfo = (airport: AirportFile): AirportInfo => ({
  id: airport.id,
  artcc: airport.artcc,
  name: airport.name,
  asdex: airport.asdex,
  twrmap: airport.twrmap,
  stars: airport.stars,
  scenarios: airport.scen.map((s) => ({ id: s.id, name: s.name, count: s.ac.length, surface: s.ac.filter((a) => a.k !== 'A').length, airborne: s.ac.filter((a) => a.k === 'A').length })),
})

/** The scenario an airport opens on: the first one with aircraft the position can load. */
export const defaultScenario = (info: AirportInfo, mode: PositionMode): string | null => {
  const loadsAirborne = positionFor(mode).rules.loadsAirborne
  const usable = info.scenarios.find((s) => (loadsAirborne ? s.count > 0 : s.surface > 0))
  return usable?.id ?? info.scenarios[0]?.id ?? null
}

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
  const withTips = pushLog(announced.model, 'sys', null, tips)
  const snapshot = snapshotOf(withTips)
  return {
    model: withTips,
    commands: [
      ...announced.commands,
      ReplaceDeepLink({ airport: info.id, scenario: scenarioId }),
      ...(snapshot === null ? [] : broadcast(withTips, SessionEvent.Snapshot({ snapshot }))),
    ],
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
        SelectedTarget: ({ callsign }) => ({ model: evo(model, { selected: () => callsign, radial: () => null }), commands: [FocusCommand()] }),
        Noted: ({ text }) => ({ model: pushLog(model, 'sys', null, text) }),
      }),
  })

// AI

const promptFor = (model: Model, world: World, audio: boolean) =>
  buildPrompt({ world, airportName: infoOf(model)?.name ?? world.airport.name, positionLabel: positionLabel(model.settings.mode), selected: model.selected, audio })

const pttIdle = (model: Model): Model => evo(model, { ptt: () => 'idle', pendingAi: () => null })

/**
 * Run a translated transmission: select, execute each command with the pilot's
 * per-command lines suppressed, then log and speak the model's single readback.
 */
export const applyTranslation = (model: Model, translation: Translation, said: string): Return => {
  const world = worldOf(model)
  if (world === null) {
    return { model: pttIdle(model) }
  }
  const named = translation.callsign !== null ? matchCallsign(world, translation.callsign) : null
  const callsign = named?.callsign ?? (translation.callsign === null ? model.selected : null)
  const logged = pushLog(pttIdle(model), 'atc', null, said)
  if (callsign === null) {
    return {
      model: pushLog(logged, 'err', null, `no aircraft matched "${translation.callsign ?? '—'}"${translation.readback !== null ? ' — ' + translation.readback : ''}`),
    }
  }
  const selected = evo(logged, { selected: () => callsign })
  const ran = translation.commands.reduce<Ran>(
    (state, line) => {
      const w = worldOf(state.model)
      if (w === null) {
        return state
      }
      const parsed = parseCommandLine(w, callsign, `${callsign} ${line}`)
      if (parsed._tag === 'Parsed') {
        const out = dispatchCommand(state.model, parsed.callsign, parsed.command, null, true)
        return { model: out.model, commands: [...state.commands, ...out.commands], ok: state.ok && out.ok }
      }
      const error = parsed._tag === 'Invalid' ? `unable — ${parsed.error}` : `could not run "${line}"`
      return { model: pushLog(state.model, 'err', callsign, error), commands: state.commands, ok: false }
    },
    { model: selected, commands: [], ok: true },
  )
  if (translation.readback === null || !ran.ok) {
    return { model: ran.model, commands: ran.commands }
  }
  const spokenText = translation.spoken ?? spokenFreeText(translation.readback)
  return {
    model: pushLog(ran.model, 'pilot', callsign, translation.readback),
    commands: ran.model.settings.tts ? [...ran.commands, speakCommand(ran.model.settings, callsign, spokenText)] : ran.commands,
  }
}

const status = (model: Model, text: string, kind: Model['settingsStatus']['kind']): Model => evo(model, { settingsStatus: () => ({ text, kind }) })

const draftUtterance = (model: Model, callsign: string, text: string) =>
  TestVoice({
    callsign,
    text,
    engine: model.draft.ttsEngine,
    key: model.draft.key.trim(),
    model: model.draft.ttsModel.trim() || defaultSettings.ttsModel,
    providerVoice: model.draft.ttsVoice,
    browserVoice: model.draft.voice,
    radio: model.draft.radio,
  })

// UPDATE

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    CompletedLoadSettings: ({ settings }) => ({
      model: evo(model, { settings: () => settings, draft: () => settings }),
      commands: [ReadDeepLink(), ProbeRecognition()],
    }),

    CompletedReadDeepLink: ({ airport, scenario, room }) => ({
      model: withSession(evo(model, { deepLink: () => ({ airport, scenario, room }), index: () => IndexLoad.Loading() }), room === null ? {} : { role: 'guest', room, status: 'connecting', roomInput: room }),
      commands: [LoadIndex({ source: sourceForProxy(model.settings.proxy) }), ...(room === null ? [] : [JoinRoom({ room, turn: turnOf(model.settings) })])],
    }),

    ChangedDeepLink: ({ airport, scenario, room }) => {
      if (room !== null && model.session.room !== room) {
        return {
          model: withSession(evo(model, { deepLink: () => ({ airport, scenario, room }) }), { role: 'guest', room, status: 'connecting', roomInput: room, error: null }),
          commands: [JoinRoom({ room, turn: turnOf(model.settings) })],
        }
      }
      if (airport === null) {
        return { model }
      }
      const withLink = evo(model, { deepLink: () => ({ airport, scenario, room }) })
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
      const pavement = pavementFor(airport.asdex, airport.twrmap, model.settings.asdexCabMap)
      const radar = starsInit(model.stars, airport.artcc, airport.stars, positionFor(model.settings.mode).scopeRangeNm)
      const fitted: Model = {
        ...model,
        airport: { _tag: 'Ready', info, world },
        pavement: pavement === null ? Pavement.None() : Pavement.Loading({ id: pavement.id }),
        scope: fit(world.graph, { ...model.scope, fitted: false }),
        stars: radar.model,
      }
      const pending = model.session.pendingSnapshot
      const wanted = model.deepLink.airport === airport.id ? model.deepLink.scenario : null
      const scenarioId = wanted !== null && info.scenarios.some((s) => s.id === wanted) ? wanted : defaultScenario(info, model.settings.mode)
      const next =
        isGuest(model) && pending !== null && pending.airportId === airport.id && model.session.hostId !== null
          ? applySnapshot(fitted, pending, model.session.hostId)
          : selectScenario(fitted, scenarioId)
      return {
        model: next.model,
        commands: [
          ...(next.commands ?? []),
          ...(pavement === null ? [] : [LoadPavement({ artcc: airport.artcc, id: pavement.id, asdex: pavement.asdex })]),
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
      const since = Math.min(now - model.lastTickAt, MAX_BACKLOG_MS)
      const n = Math.min(MAX_STEPS_PER_TICK, Math.floor(since / TICK_MS))
      if (n <= 0) {
        return { model }
      }
      const clocked = evo(model, { lastTickAt: () => now - since + n * TICK_MS })
      if (!model.running || isGuest(model)) {
        return { model: clocked }
      }
      const steps = n * model.rate
      const stepped = stepWorldTimes(world, steps)
      const applied = applyEvents(withWorld(clocked, stepped.world), stepped.events)
      return { model: applied.model, commands: [...applied.commands, ...broadcast(model, SessionEvent.Stepped({ steps }))] }
    },

    ChangedPosition: ({ mode }) => control(model, SessionControl.SetPosition({ mode })),

    ChangedArtcc: ({ id }) => {
      if (model.index._tag !== 'Ready') {
        return { model }
      }
      const first = model.index.index.artccs.find((a) => a.id === id)?.airports[0]
      return first === undefined ? { model } : startLoadingAirport(model, first.id)
    },

    ChangedAirport: ({ id }) => startLoadingAirport(model, id),

    ChangedScenario: ({ id }) =>
      isGuest(model)
        ? { model, commands: [SendSession({ event: SessionEvent.RequestedScenario({ scenarioId: id === '' ? null : id }), target: model.session.hostId })] }
        : selectScenario(model, id === '' ? null : id),

    ClickedTogglePlay: () => control(model, SessionControl.SetRunning({ running: !model.running })),

    ClickedRate: () => control(model, SessionControl.SetRate({ rate: cycleRate(model.rate) })),

    ClickedArrivals: () => {
      const world = worldOf(model)
      return world === null ? { model } : control(model, SessionControl.SetArrivals({ enabled: !world.arrivalsEnabled }))
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
      return hit === null
        ? { model: evo(released, { radial: () => null }) }
        : {
            model: evo(released, { selected: () => hit.callsign, radial: () => null }),
            commands: [FocusCommand()],
          }
    },

    /** A right-click: select the aircraft under it and open its command ring; over empty pavement, close the ring. Any drag the press started is dropped. */
    ContextScope: ({ x, y }) => {
      const world = worldOf(model)
      const released = evo(model, { drag: () => null })
      if (world === null) {
        return { model: released }
      }
      const hit = hitTest(world.graph, model.scope, x, y, world.aircraft.filter((a) => a.delay <= 0), (a) => a.position)
      return hit === null
        ? { model: evo(released, { radial: () => null }) }
        : { model: evo(released, { selected: () => hit.callsign, radial: () => ({ callsign: hit.callsign, trail: [] }) }), commands: [FocusCommand()] }
    },

    PickedRadial: ({ key }) => {
      const radial = model.radial
      const world = worldOf(model)
      const aircraft = radial === null || world === null ? undefined : findAircraft(world, radial.callsign)
      if (radial === null || world === null || aircraft === undefined) {
        return { model: evo(model, { radial: () => null }) }
      }
      const trail = [...radial.trail, key]
      const next = radialAt(world, model.settings.mode, aircraft, trail)
      if (next === null) {
        return { model }
      }
      return next._tag === 'Line'
        ? submitLine(evo(model, { radial: () => null }), `${radial.callsign} ${next.line}`)
        : { model: evo(model, { radial: () => ({ ...radial, trail }) }) }
    },

    ClickedRadialBack: () => ({
      model: evo(model, { radial: (r) => (r === null || r.trail.length === 0 ? null : { ...r, trail: r.trail.slice(0, -1) }) }),
    }),

    ClosedRadial: () => ({ model: evo(model, { radial: () => null }) }),

    ClickedAsdexPanel: () => ({ model: evo(model, { asdexPanelOpen: (open) => !open }) }),
    PressedOutsideAsdexPanel: () => ({ model: evo(model, { asdexPanelOpen: () => false }) }),
    ToggledParkedTags: () => saveSettings(model, { ...model.settings, asdexParkedTags: !model.settings.asdexParkedTags }),
    ChangedTagSize: ({ delta }) =>
      saveSettings(model, { ...model.settings, asdexTagSize: Math.max(MIN_TAG_SIZE, Math.min(MAX_TAG_SIZE, model.settings.asdexTagSize + delta)) }),

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

    ClickedStrip: ({ callsign }) => ({ model: evo(model, { selected: () => callsign, radial: () => null }), commands: [FocusCommand()] }),

    UpdatedCommandText: ({ value }) => ({ model: evo(model, { commandText: () => value }) }),

    SubmittedCommand: () => submitLine(evo(model, { commandText: () => '' }), model.commandText.trim()),

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

    IssuedCommand: ({ callsign, command }) => {
      const ran = dispatchCommand(model, callsign, command, null)
      return { model: ran.model, commands: ran.commands }
    },

    ClickedSpeaker: () => {
      const settings = { ...model.settings, tts: !model.settings.tts }
      return {
        model: pushLog(evo(model, { settings: () => settings }), 'sys', null, settings.tts ? 'pilot voices on' : 'pilot voices off'),
        commands: [SaveSettings({ settings }), ...(settings.tts ? [] : [StopSpeaking()])],
      }
    },

    ClickedHelp: () => ({ model: evo(model, { dialog: () => 'help' }) }),

    ClickedSettings: () => ({
      model: status(evo(model, { dialog: () => 'settings', draft: () => model.settings }), '', ''),
      commands: [LoadBrowserVoices(), ...(model.settings.key !== '' && model.models === null ? [LoadModels({ key: model.settings.key })] : [])],
    }),

    ClosedDialog: () => ({ model: evo(model, { dialog: () => 'none' }) }),

    UpdatedDraft: ({ draft }) => ({ model: evo(model, { draft: () => draft }) }),

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
      const warning = keyWarning(settings.key)
      const logged = pushLog(
        warning === null ? saved : pushLog(saved, 'err', null, warning),
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

    /** Switch between ASDE-X pavement and the tower-cab map; the other map is loaded (or taken from the cache) at once. */
    ToggledCabMap: () => {
      const saved = saveSettings(model, { ...model.settings, asdexCabMap: !model.settings.asdexCabMap })
      const info = infoOf(model)
      const pavement = info === null ? null : pavementFor(info.asdex, info.twrmap, saved.model.settings.asdexCabMap)
      if (info === null || pavement === null || (model.pavement._tag !== 'None' && model.pavement._tag !== 'Failed' && model.pavement.id === pavement.id)) {
        return saved
      }
      return {
        model: evo(saved.model, { pavement: () => Pavement.Loading({ id: pavement.id }) }),
        commands: [...(saved.commands ?? []), LoadPavement({ artcc: info.artcc, id: pavement.id, asdex: pavement.asdex })],
      }
    },

    /** Show or hide one layer of the tower-cab map on the scope; remembered per map id. */
    ToggledCabLayer: ({ key }) => {
      if (model.pavement._tag !== 'Ready' || model.pavement.asdex) {
        return { model }
      }
      const id = model.pavement.id
      const off = model.settings.cabLayersOff[id] ?? []
      const next = off.includes(key) ? off.filter((k) => k !== key) : [...off, key]
      const { [id]: _, ...rest } = model.settings.cabLayersOff
      return saveSettings(model, { ...model.settings, cabLayersOff: next.length === 0 ? rest : { ...rest, [id]: next } })
    },

    ClickedPane: ({ view }) => saveSettings(model, { ...model.settings, view }),

    DraggedSplit: ({ ratio }) => {
      const split = Math.round(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ratio)) * 1000) / 1000
      return { model: evo(model, { settings: (s) => ({ ...s, split }), draft: (d) => ({ ...d, split }) }) }
    },

    ReleasedSplit: () => saveSettings(model, model.settings),

    GotStars: ({ message }) => {
      const info = infoOf(model)
      return foldStars(info?.artcc ?? '')(model, { message, world: worldOf(model) })
    },

    // PUSH-TO-TALK

    PressedPtt: () => {
      if (worldOf(model) === null || model.ptt !== 'idle') {
        return { model }
      }
      if (aiEnabled(model.settings)) {
        return { model: evo(model, { ptt: () => 'tx' }), commands: [StartRecording()] }
      }
      if (!model.recognitionAvailable) {
        return { model: pushLog(model, 'err', null, 'no speech recognition in this browser — add an OpenRouter key in Settings for audio') }
      }
      return { model: evo(model, { ptt: () => 'listen' }), commands: [StartRecognition()] }
    },

    ReleasedPtt: () => {
      if (model.ptt === 'tx') {
        return { model, commands: [StopRecording()] }
      }
      if (model.ptt === 'listen') {
        return { model: evo(model, { ptt: () => 'idle' }), commands: [StopRecognition()] }
      }
      return { model }
    },

    CompletedStartRecording: () => ({ model }),

    FailedStartRecording: ({ error }) => ({ model: pushLog(pttIdle(model), 'err', null, `microphone unavailable (${error})`) }),

    CompletedStopRecording: ({ wavBase64, seconds }) => {
      const world = worldOf(model)
      if (wavBase64 === null || world === null) {
        return { model: pushLog(pttIdle(model), 'sys', null, 'transmission too short') }
      }
      const prompt = promptFor(model, world, true)
      return {
        model: evo(model, { ptt: () => 'busy', pendingAi: () => `transcribing ${seconds.toFixed(1)}s…` }),
        commands: [
          TranslateAudio({
            key: model.settings.key,
            model: model.settings.audioModel || model.settings.model,
            system: prompt.system,
            user: prompt.user,
            wavBase64,
          }),
        ],
      }
    },

    FailedStopRecording: ({ error }) => ({ model: pushLog(pttIdle(model), 'err', null, `could not encode audio (${error})`) }),

    CompletedTranslate: ({ translation, said }) => applyTranslation(model, translation, said),

    FailedTranslate: ({ error, audio }) => ({
      model: pushLog(pttIdle(model), 'err', null, audio ? `could not understand that transmission (${error})` : `could not translate that (${error}) — try the command syntax`),
    }),

    CompletedStartRecognition: () => ({ model }),

    FailedStartRecognition: ({ error }) => ({ model: pushLog(pttIdle(model), 'err', null, `speech recognition unavailable (${error})`) }),

    CompletedStopRecognition: () => ({ model }),

    HeardRecognition: ({ text }) => update(evo(model, { commandText: () => text }), Message.SubmittedCommand()),

    FailedRecognition: ({ error }) => ({ model: pushLog(pttIdle(model), 'err', null, `speech recognition: ${error}`) }),

    EndedRecognition: () => ({ model: model.ptt === 'listen' ? evo(model, { ptt: () => 'idle' }) : model }),

    CompletedSpeak: () => ({ model }),
    CompletedStopSpeaking: () => ({ model }),

    ReportedSpeechFallback: ({ error }) => ({ model: pushLog(model, 'err', null, `OpenRouter voice failed (${error}) — falling back to the browser voice`) }),

    CompletedLoadBrowserVoices: ({ voices }) => ({ model: evo(model, { browserVoices: () => voices }) }),

    CompletedProbeRecognition: ({ available }) => ({ model: evo(model, { recognitionAvailable: () => available }) }),

    // SETTINGS

    ClickedLoadModels: () => {
      const key = model.draft.key.trim()
      if (key === '') {
        return { model: status(model, 'enter a key first', 'bad') }
      }
      const warning = keyWarning(key)
      return { model: status(model, warning ?? 'loading model list…', warning === null ? '' : 'bad'), commands: [LoadModels({ key })] }
    },

    CompletedLoadModels: ({ models }) => ({
      model: status(evo(model, { models: () => models }), `${models.ids.length} models loaded, ${models.audioIds.length} with audio input, ${Object.keys(models.speech).length} speech models`, 'ok'),
    }),

    FailedLoadModels: ({ error }) => ({ model: status(model, `could not load models: ${error}`, 'bad') }),

    ClickedTestKey: () => {
      const key = model.draft.key.trim()
      const chat = model.draft.model.trim()
      if (key === '' || chat === '') {
        return { model: status(model, 'enter a key and a model first', 'bad') }
      }
      const warning = keyWarning(key)
      if (warning !== null) {
        return { model: status(model, warning, 'bad') }
      }
      return { model: status(model, 'testing…', ''), commands: [TestKey({ key, model: chat })] }
    },

    CompletedTestKey: ({ ok, detail }) => ({ model: status(model, detail, ok ? 'ok' : 'bad') }),

    ClickedTestVoice: () => {
      if (model.draft.ttsEngine === 'openrouter' && model.draft.key.trim() === '') {
        return { model: status(model, 'OpenRouter voices need an API key', 'bad') }
      }
      const warning = model.draft.ttsEngine === 'openrouter' ? keyWarning(model.draft.key.trim()) : null
      if (warning !== null) {
        return { model: status(model, warning, 'bad') }
      }
      return { model: status(model, model.draft.ttsEngine === 'openrouter' ? 'fetching speech…' : '', ''), commands: [draftUtterance(model, 'DAL1047', TEST_VOICE_SAMPLE)] }
    },

    CompletedTestVoice: ({ detail, ok }) => ({ model: status(model, detail, ok ? 'ok' : 'bad') }),

    // SHARED SESSIONS

    ClickedSession: () => ({ model: evo(model, { dialog: () => 'session' }) }),

    ClickedHostSession: () => ({
      model: withSession(model, { role: 'host', status: 'connecting', error: null, peers: [], hostId: null }),
      commands: [HostRoom({ turn: turnOf(model.settings) })],
    }),

    UpdatedRoomInput: ({ value }) => ({ model: withSession(model, { roomInput: value }) }),

    ClickedJoinSession: () => {
      const room = normaliseRoomCode(model.session.roomInput)
      if (!isRoomCode(room)) {
        return { model: withSession(model, { error: 'a room code is six letters and digits' }) }
      }
      return {
        model: withSession(model, { role: 'guest', room, status: 'connecting', error: null, peers: [], hostId: null }),
        commands: [JoinRoom({ room, turn: turnOf(model.settings) })],
      }
    },

    ClickedLeaveSession: () => ({
      model: pushLog(evo(model, { session: () => ({ ...initialSession, roomInput: model.session.roomInput }), lastTickAt: () => null }), 'sys', null, 'left the session — running solo from here'),
      commands: [LeaveRoom()],
    }),

    CompletedHostRoom: ({ room }) => ({
      model: pushLog(withSession(model, { role: 'host', room, status: 'connected', roomInput: room }), 'sys', null, `hosting session ${room} — share the code or the link`),
    }),

    CompletedJoinRoom: ({ room }) => ({ model: withSession(model, { role: 'guest', room, status: 'connecting' }) }),

    FailedJoinRoom: ({ error }) => ({ model: pushLog(withSession(model, { role: 'solo', status: 'failed', error }), 'err', null, `could not join the session (${error})`) }),

    CompletedLeaveRoom: () => ({ model }),
    CompletedSendSession: () => ({ model }),

    FailedSendSession: ({ error }) => ({ model: pushLog(model, 'err', null, `session send failed (${error})`) }),

    PeerJoined: ({ peerId }) => {
      const joined = withSession(model, { peers: [...model.session.peers.filter((p) => p !== peerId), peerId], status: 'connected' })
      const snapshot = snapshotOf(joined)
      return {
        model: pushLog(joined, 'sys', null, `peer ${peerId.slice(0, 6)} joined`),
        commands: isHost(model) && snapshot !== null ? [SendSession({ event: SessionEvent.Snapshot({ snapshot }), target: peerId })] : [],
      }
    },

    PeerLeft: ({ peerId }) => {
      const left = withSession(model, { peers: model.session.peers.filter((p) => p !== peerId) })
      if (isGuest(model) && peerId === model.session.hostId) {
        return {
          model: pushLog(evo(left, { session: () => ({ ...initialSession, roomInput: model.session.roomInput }), lastTickAt: () => null }), 'sys', null, 'the host left — running solo from here'),
          commands: [LeaveRoom()],
        }
      }
      return { model: pushLog(left, 'sys', null, `peer ${peerId.slice(0, 6)} left`) }
    },

    ReceivedSession: ({ peerId, event }) => receiveSession(model, peerId, event),

    /**
     * Trystero reports an ICE failure once per peer but keeps announcing and retrying, and a
     * late connection still lands (Chrome↔Firefox pairs were seen to fail once and connect on
     * the next attempt), so a guest stays in the room; Leave in the Session dialog runs solo.
     */
    FailedSession: ({ error }) => {
      const logged = pushLog(model, 'err', null, `session connection problem: ${error}`)
      return model.session.role === 'guest' && model.session.status !== 'connected'
        ? { model: pushLog(withSession(logged, { status: 'failed', error }), 'sys', null, 'still trying to reach the host — leave the session to run solo, or add a TURN server in Settings if your networks need a relay') }
        : { model: withSession(logged, { status: 'failed', error }) }
    },
  })
