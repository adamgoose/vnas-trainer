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
  LoadArtcc,
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
import { type Edge, type Layout, type Panel, availablePanels, close, defaultLayouts, dock, fitFloating, isOpen, loadedLayouts, moveFloating, open, placement, raise, resizeFloating, resizeGutter, toggleFloat } from './layout'
import { Message } from './message'
import { AirportLoad, type AirportInfo, ArtccLoad, IndexLoad, type LogLine, type Model, Pavement, artccOf, infoOf, initialModel, initialSession, isGuest, isHost, isReviewing, worldOf } from './model'
import { type Point, branchOf, currentBranch, commandLogAt, liveEnd, logAt, parkBranch, pointAt, recordChange, recordSteps, resolvePoint, resumeAt, startTimeline, worldAt } from './timeline'
import type { Services } from './subscriptions'
import { TICK_MS } from './subscriptions'
import type { AirportFile, CatalogIndex } from '../domain/catalog'
import { type AtcCommand, type DisplayCommand, executeCommand, isEramEntry, parseCommandLine } from '../domain/commands'
import { runwayEntries } from '../domain/graph'
import { type Phrase, spoken, spokenCallsign, spokenFreeText, written } from '../domain/phrase'
import { MAX_STEPS_PER_TICK, stepWorldTimes } from '../domain/physics'
import { type Translation, buildPrompt } from '../domain/prompt'
import { loadScenario } from '../domain/scenario'
import { SessionControl, SessionEvent, type Snapshot, isRoomCode, normaliseRoomCode } from '../domain/session'
import { SimEvent, type World, findAircraft, makeWorld, matchCallsign, withArtcc } from '../domain/world'
import { type PositionMode, positionFor } from '../positions'
import { INTERSECTION_HIT_FRACTION, openPlan, radialAt, runwayPickTrail } from './radial'
import { intersections } from './plan'
import { StarsOut, isDefaultMaps, rangeView, starsInit, starsUpdate } from '../positions/local/stars'
import { EramMessage, EramOut, eramInit, eramUpdate } from '../positions/center/eram'
import { handoffAccepted } from '../domain/aircraft'
import { type TurnServer } from '../services/session'
import { MAX_TAG_SIZE, MIN_TAG_SIZE, type Settings, defaultSettings } from '../services/settings'
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

/** Replace the World after a change that was not a step, and mark it on the time graph. */
const withWorldChange = (model: Model, world: World, label: string): Model => evo(withWorld(model, world), { timeline: (t) => recordChange(t, world, label) })

const pushLog = (model: Model, kind: LogLine['kind'], who: string | null, text: string): Model =>
  evo(model, { log: (log) => [{ kind, time: worldOf(model)?.simTime ?? 0, who, text }, ...log].slice(0, 140) })

const REWOUND_HINT = 'rewound — Resume forks the timeline here; Live returns to the present'

const tPlus = (seconds: number): string => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

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
    timeline: (t) => recordChange(t, result.world, said ?? `${callsign ?? ''} ${command._tag.toUpperCase()}`.trim()),
  })
  const applied = applyEvents(recorded, result.events, { quiet })
  return { model: applied.model, commands: [...applied.commands, ...broadcast(model, SessionEvent.Commanded({ callsign, command, said }))], ok: true }
}

/**
 * Where a command goes: a guest asks the host and applies it when the host's
 * broadcast comes back; the host and a solo player execute it here.
 */
const dispatchCommand = (model: Model, callsign: string | null, command: AtcCommand, said: string | null, quiet = false): Ran =>
  isReviewing(model)
    ? { model: pushLog(model, 'err', null, REWOUND_HINT), commands: [], ok: false }
    : isGuest(model)
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
    const failed = pushLog(pushLog(selected, 'atc', null, text), 'err', parsed.callsign, `unable — ${parsed.error}`)
    return model.settings.mode === 'center' ? answerEram(failed, false, parsed.error.toUpperCase()) : { model: failed }
  }
  if (parsed._tag === 'Display') {
    return displayLine(selected, text, parsed.callsign, parsed.display)
  }
  const ran = dispatchCommand(isGuest(selected) ? selected : pushLog(selected, 'atc', null, text), parsed.callsign, parsed.command, text)
  if (!isEramEntry(parsed.command) && model.settings.mode !== 'center') {
    return { model: ran.model, commands: ran.commands }
  }
  const answered = ran.ok ? answerEram(ran.model, true, 'ACCEPT') : answerEram(ran.model, false, (ran.model.log[0]?.text ?? 'REJECT').replace(/^unable — /, '').toUpperCase())
  const readout = parsed.command._tag === 'FlightPlanReadout' && ran.ok ? respondEram(answered.model, [ran.model.log.find((l) => l.kind === 'sys')?.text ?? '']) : answered
  return { model: readout.model, commands: [...ran.commands, ...(answered.commands ?? []), ...(readout.commands ?? [])] }
}

/** An ERAM display entry: a bare flight id recalls a pending handoff, everything else goes to the ERAM pane. */
const displayLine = (model: Model, text: string, callsign: string | null, display: DisplayCommand): Return => {
  const world = worldOf(model)
  const aircraft = callsign === null || world === null ? undefined : findAircraft(world, callsign)
  const logged = pushLog(model, 'atc', null, text)
  if (display._tag === 'ToggleBlock' && aircraft !== undefined && aircraft.handoffSector !== null && world !== null && !handoffAccepted(aircraft, world.simTime)) {
    const ran = dispatchCommand(logged, callsign, { _tag: 'RecallHandoff' }, text)
    const answered = ran.ok ? answerEram(ran.model, true, 'ACCEPT') : answerEram(ran.model, false, 'REJECT')
    return { model: answered.model, commands: [...ran.commands, ...(answered.commands ?? [])] }
  }
  const focused = display._tag === 'ToggleBlock' && callsign !== null ? evo(logged, { selected: () => callsign }) : logged
  return foldEram(focused, EramMessage.Displayed({ callsign, display, simTime: world?.simTime ?? 0 }))
}

const answerEram = (model: Model, ok: boolean, text: string): Return => foldEram(model, EramMessage.Answered({ ok, text }))
const respondEram = (model: Model, lines: ReadonlyArray<string>): Return => foldEram(model, EramMessage.Responded({ lines }))

/** A pick on the open ring: descend, edit the plan, close, or issue the command line reached. */
const pickRadial = (model: Model, key: string): Return => {
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
  if (next._tag === 'Close') {
    return { model: evo(model, { radial: () => null }) }
  }
  return next._tag === 'Line'
    ? submitLine(evo(model, { radial: () => null }), `${radial.callsign} ${next.line}`)
    : { model: evo(model, { radial: () => ({ ...radial, trail }) }) }
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

// WINDOWS

/** The layout of the position in use, without the panels it lacks. */
export const activeLayout = (model: Model): Layout => model.settings.layouts[model.settings.mode]

/**
 * Change the layout of the position in use. Only `layouts` moves in the draft, so
 * an edit in progress in the Settings window survives a window being dragged.
 */
const withLayout = (model: Model, f: (layout: Layout) => Layout): Model => {
  const mode = model.settings.mode
  const layouts = { ...model.settings.layouts, [mode]: f(model.settings.layouts[mode]) }
  return evo(model, { settings: (s) => ({ ...s, layouts }), draft: (d) => ({ ...d, layouts }) })
}

const persistLayout = (model: Model): Return => ({ model, commands: [SaveSettings({ settings: model.settings })] })

/** Open a window, with what opening it used to do as a dialog: Settings reloads its draft and lists, Rewind is the host's. */
const openWindow = (model: Model, panel: Panel): Return => {
  if (!availablePanels(model.settings.mode).includes(panel)) {
    return { model }
  }
  const opened = withLayout(model, (l) => raise(open(l, panel, model.workspace), panel))
  if (panel === 'settings') {
    return {
      model: status(evo(opened, { draft: () => opened.settings }), '', ''),
      commands: [SaveSettings({ settings: opened.settings }), LoadBrowserVoices(), ...(model.settings.key !== '' && model.models === null ? [LoadModels({ key: model.settings.key })] : [])],
    }
  }
  return persistLayout(opened)
}

/** Close a window; closing Rewind while rewound returns to the present, as the old button did. */
const closeWindow = (model: Model, panel: Panel): Return => {
  const live = panel === 'rewind' && isReviewing(model) ? goLive(model) : { model }
  const closed = evo(withLayout(live.model, (l) => close(l, panel)), { fullscreen: (f) => (f === panel ? null : f) })
  return { model: closed, commands: [...(live.commands ?? []), SaveSettings({ settings: closed.settings })] }
}

const toggleWindow = (model: Model, panel: Panel): Return => (isOpen(activeLayout(model), panel) ? closeWindow(model, panel) : openWindow(model, panel))

/** A drag on a gutter, a title bar or a resize grip (see `DragHandle`). */
const dragHandle = (model: Model, drag: ReturnType<typeof Message.DraggedHandle>): Return => {
  if (drag.kind === 'gutter') {
    const path = drag.key === '' ? [] : drag.key.split('.').map(Number)
    const resized = drag.phase === 'move' ? withLayout(model, (l) => resizeGutter(l, path, drag.index, drag.fraction)) : model
    return drag.phase === 'up' ? persistLayout(resized) : { model: resized }
  }
  const panel = drag.key as Panel
  if (!(availablePanels(model.settings.mode) as ReadonlyArray<string>).includes(panel)) {
    return { model }
  }
  if (drag.kind === 'resize') {
    const grip = drag.grip
    const resized = drag.phase === 'move' && grip !== null ? withLayout(model, (l) => resizeFloating(l, panel, grip, drag.x, drag.y, model.workspace, !drag.alt)) : model
    return drag.phase === 'up' ? persistLayout(resized) : { model: resized }
  }
  const layout = activeLayout(model)
  const floating = layout.floating.find((f) => f.panel === panel)
  if (drag.phase === 'down') {
    const raised = floating === undefined ? model : withLayout(model, (l) => raise(l, panel))
    return {
      model: evo(raised, {
        windowDrag: () => ({ panel, startX: drag.x, startY: drag.y, originX: floating?.x ?? 0, originY: floating?.y ?? 0, moved: false, over: null, edge: null }),
      }),
    }
  }
  const current = model.windowDrag
  if (current === null || current.panel !== panel) {
    return { model }
  }
  const moved = current.moved || Math.hypot(drag.x - current.startX, drag.y - current.startY) > 4
  const over = moved && drag.over !== panel ? drag.over : null
  const edge: Edge | null = over === null ? null : drag.edge
  if (drag.phase === 'move') {
    const tracked = evo(model, { windowDrag: () => ({ ...current, moved, over, edge }) })
    return {
      model: floating === undefined || !moved ? tracked : withLayout(tracked, (l) => moveFloating(l, panel, current.originX + drag.x - current.startX, current.originY + drag.y - current.startY, model.workspace, !drag.alt)),
    }
  }
  const dropped = evo(model, { windowDrag: () => null })
  if (moved && over !== null && edge !== null) {
    return persistLayout(withLayout(dropped, (l) => dock(l, panel, over, edge)))
  }
  return floating !== undefined && moved ? persistLayout(dropped) : { model: dropped }
}

// REWIND

/** The point being looked at: the review, or the live end. */
const viewedPoint = (model: Model): Point | null => model.review ?? liveEnd(model.timeline)

/**
 * Show the World at a point of the graph. The first rewind parks the live log
 * on the branch being extended and pauses the sim (a host tells its peers);
 * later scrubs step from the World already shown when that is cheaper.
 */
const scrubTo = (model: Model, branch: number, tick: number): Return => {
  if (isGuest(model) || worldOf(model) === null) {
    return { model }
  }
  const point = resolvePoint(model.timeline, branch, tick)
  const end = liveEnd(model.timeline)
  if (point === null || end === null) {
    return { model }
  }
  if (model.review === null && point.branch === end.branch && point.tick === end.tick) {
    return { model }
  }
  const timeline = model.review === null ? parkBranch(model.timeline, model.log, model.commandLog) : model.timeline
  const shown = worldOf(model)
  const hint = model.review !== null && shown !== null ? { point: model.review, world: shown } : null
  const world = worldAt(timeline, point, hint)
  const target = branchOf(timeline, point.branch)
  if (world === null || target === undefined) {
    return { model }
  }
  const wasRunning = model.review?.wasRunning ?? model.running
  const next = evo(withWorld(model, world), {
    timeline: () => timeline,
    review: () => ({ branch: point.branch, tick: point.tick, wasRunning }),
    running: () => false,
    lastTickAt: () => null,
    log: () => logAt(target, world.simTime),
    commandLog: () => commandLogAt(target, point.tick),
    selected: (s) => (s !== null && findAircraft(world, s) !== undefined ? s : null),
    radial: () => null,
  })
  return { model: next, commands: model.review === null ? broadcast(model, SessionEvent.Controlled({ control: SessionControl.SetRunning({ running: false }) })) : [] }
}

/** Back to the present: the end of the branch being extended, its log, and the clock as it was. */
const goLive = (model: Model): Return => {
  const review = model.review
  const branch = currentBranch(model.timeline)
  const end = liveEnd(model.timeline)
  const world = end === null ? null : worldAt(model.timeline, end)
  if (review === null || branch === undefined || world === null) {
    return { model: evo(model, { review: () => null }) }
  }
  const next = evo(withWorld(model, world), {
    review: () => null,
    running: () => review.wasRunning,
    lastTickAt: () => null,
    log: () => branch.log,
    commandLog: () => branch.commandLog,
    selected: (s) => (s !== null && findAircraft(world, s) !== undefined ? s : null),
    radial: () => null,
  })
  return { model: next, commands: broadcast(model, SessionEvent.Controlled({ control: SessionControl.SetRunning({ running: review.wasRunning }) })) }
}

/** Resume the sim from the point shown: a fork before the end of a branch, a continuation at it. Peers take a fresh snapshot. */
const resumeHere = (model: Model): Return => {
  const review = model.review
  const world = worldOf(model)
  if (review === null || world === null) {
    return { model }
  }
  const resumed = resumeAt(model.timeline, review, world)
  if (resumed === null) {
    return goLive(model)
  }
  const next = evo(model, {
    timeline: () => resumed.timeline,
    review: () => null,
    running: () => review.wasRunning,
    lastTickAt: () => null,
    log: () => resumed.branch.log,
    commandLog: () => resumed.branch.commandLog,
  })
  const logged = pushLog(
    next,
    'sys',
    null,
    resumed.forked ? `rewound to T+${tPlus(world.simTime)} — branch ${resumed.branch.id + 1} forks here; the old future stays on the timeline` : `continuing branch ${resumed.branch.id + 1} from T+${tPlus(world.simTime)}`,
  )
  const snapshot = snapshotOf(logged)
  return {
    model: logged,
    commands: [
      ...(snapshot === null ? [] : broadcast(logged, SessionEvent.Snapshot({ snapshot }))),
      ...broadcast(logged, SessionEvent.Controlled({ control: SessionControl.SetRunning({ running: review.wasRunning }) })),
    ],
  }
}

// SESSION HELPERS

const turnOf = (settings: Settings): TurnServer | null =>
  settings.turnUrl.trim() === '' ? null : { url: settings.turnUrl.trim(), username: settings.turnUsername, credential: settings.turnCredential }

const broadcast = (model: Model, event: SessionEvent): Commands => (isHost(model) ? [SendSession({ event, target: null })] : [])

/** What a peer should follow: the present, even while this browser is looking at the past. */
const snapshotOf = (model: Model): Snapshot | null => {
  const end = liveEnd(model.timeline)
  const world = model.review !== null && end !== null ? worldAt(model.timeline, end) : worldOf(model)
  const info = infoOf(model)
  if (world === null || info === null) {
    return null
  }
  return { airportId: info.id, artcc: info.artcc, scenarioId: world.scenario?.id ?? null, world, running: model.review?.wasRunning ?? model.running, rate: model.rate, mode: model.settings.mode }
}

/** A fresh time graph rooted at the World now in the model; any rewind in progress ends. */
const restartTimeline = (model: Model): Model => {
  const world = worldOf(model)
  return evo(model, {
    timeline: () => (world === null ? model.timeline : startTimeline(world)),
    review: () => null,
    running: (running) => model.review?.wasRunning ?? running,
  })
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
      const next = withWorldChange(model, { ...world, arrivalsEnabled: enabled, nextArrivalAt: world.simTime + 5 }, enabled ? 'arrivals on' : 'arrivals off')
      return {
        model: pushLog(next, 'sys', null, enabled ? `arrival generator on — ${world.airport.fleet.length > 0 ? `${world.airport.id} fleet mix` : 'generic GA mix'}` : 'arrival generator off'),
      }
    },
    SetAutoTrack: ({ enabled }) => {
      const world = worldOf(model)
      if (world === null || world.autoTrack === enabled) {
        return { model }
      }
      return { model: pushLog(withWorldChange(model, { ...world, autoTrack: enabled }, enabled ? 'auto-track on' : 'auto-track off'), 'sys', null, enabled ? 'auto-track on — targets are tracked as radar acquires them' : 'auto-track off — TRACK starts a track') }
    },
    SetPosition: ({ mode }) => {
      const settings = { ...model.settings, mode }
      const world = worldOf(model)
      const switched = evo(model, { settings: () => settings, draft: () => settings })
      const withRules = world === null ? switched : withWorldChange(switched, { ...world, rules: rulesFor(mode) }, `${positionLabel(mode)} position`)
      const ranged = evo(withRules, {
        stars: (stars) => ({ ...stars, view: rangeView(positionFor(mode).scopeRangeNm) }),
        eram: (eram) => (mode === 'center' ? { ...eram, view: rangeView(positionFor(mode).scopeRangeNm) } : eram),
      })
      const logged = world === null ? ranged : pushLog(ranged, 'sys', null, `${positionLabel(mode)} position — try: ${positionTips(mode, world)}`)
      return { model: logged, commands: [SaveSettings({ settings })] }
    },
  })

/** A control from the UI: guests ask the host; the host applies and broadcasts. */
const control = (model: Model, c: SessionControl): Return => {
  if (isReviewing(model)) {
    return c._tag === 'SetRunning' ? (c.running ? resumeHere(model) : { model }) : c._tag === 'SetRate' ? applyControl(model, c) : { model: pushLog(model, 'err', null, REWOUND_HINT) }
  }
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
    return loadAirport(withSession(evo(model, { pavement: () => Pavement.None(), selected: () => null }), { pendingSnapshot: snapshot, hostId }), snapshot.airportId, snapshot.artcc)
  }
  const settings = { ...model.settings, mode: snapshot.mode }
  const taken = evo(restartTimeline(withWorld(model, snapshot.world)), {
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
      return applyEvents(evo(withWorld(model, stepped.world), { timeline: (t) => recordSteps(t, stepped.world) }), stepped.events)
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

/**
 * Load an airport. Its ARTCC file (ERAM GeoMaps, sectors, en-route nav) comes
 * first when it is not the one already loaded, so the World is made with it;
 * the airport follows from CompletedLoadArtcc (or FailedLoadArtcc: an old
 * catalog has no ARTCC files, and the airport still works without one).
 */
const loadAirport = (model: Model, id: string, artcc: string): Return => {
  const loading = evo(model, { airport: () => AirportLoad.Loading({ id }) })
  const source = sourceForProxy(model.settings.proxy)
  const have = artccOf(model)
  if (have !== null && have.id === artcc) {
    return { model: loading, commands: [LoadAirport({ source, id, artcc })] }
  }
  return { model: evo(loading, { artcc: () => ArtccLoad.Loading({ id: artcc }) }), commands: [LoadArtcc({ source, id: artcc })] }
}

const startLoadingAirport = (model: Model, id: string): Return => {
  if (model.index._tag !== 'Ready') {
    return { model }
  }
  const artcc = findArtcc(model.index.index, id)
  if (artcc === undefined) {
    return { model: evo(model, { airport: () => AirportLoad.Failed({ id, error: `unknown airport ${id}` }) }) }
  }
  return loadAirport(evo(model, { pavement: () => Pavement.None(), selected: () => null }), id, artcc.id)
}

/** The ARTCC file arrived (or did not): load the airport that was waiting for it. */
const afterArtcc = (model: Model): Return => {
  if (model.airport._tag !== 'Loading' || model.index._tag !== 'Ready') {
    return { model }
  }
  const id = model.airport.id
  const artcc = findArtcc(model.index.index, id)
  return artcc === undefined ? { model } : { model, commands: [LoadAirport({ source: sourceForProxy(model.settings.proxy), id, artcc: artcc.id })] }
}

/** Apply a loaded (or empty) scenario: fresh log, selection and command log, hash updated. */
const applyScenario = (model: Model, scenarioId: string | null, scenario: Parameters<typeof loadScenario>[1]): Return => {
  const world = worldOf(model)
  const info = infoOf(model)
  if (world === null || info === null) {
    return { model }
  }
  const loaded = loadScenario(world, scenario)
  const fresh = evo(restartTimeline(withWorld(model, loaded.world)), {
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
        ContextTarget: ({ callsign }) =>
          callsign === null
            ? { model: evo(model, { radial: () => null }) }
            : { model: evo(model, { selected: () => callsign, radial: () => ({ pane: 'stars' as const, callsign, trail: [] }) }), commands: [FocusCommand()] },
        ClickedEmpty: () => ({ model: evo(model, { radial: (r) => (r?.pane === 'stars' ? null : r) }) }),
        Noted: ({ text }) => ({ model: pushLog(model, 'sys', null, text) }),
      }),
  })

/** The ERAM Submodel: like STARS; a GeoMap or filter change is remembered per ARTCC in Settings. */
const foldEram = (model: Model, message: EramMessage): Return =>
  Update.foldChild({
    update: (eram: Model['eram'], input: Parameters<typeof eramUpdate>[1]) => eramUpdate(eram, input),
    read: (m: Model) => Option.some(m.eram),
    write: (m: Model, eram: Model['eram']) => evo(m, { eram: () => eram }),
    toParentMessage: (m) => Message.GotEram({ message: m }),
    foldOutMessage: (out: EramOut) => (m: Model) =>
      EramOut.match<Return>(out, {
        SelectedTarget: ({ callsign }) => ({ model: evo(m, { selected: () => callsign, radial: () => null }), commands: [FocusCommand()] }),
        Noted: ({ text }) => ({ model: pushLog(m, 'sys', null, text) }),
        ChangedGeoMap: ({ geoMap, filters }) => {
          const artcc = artccOf(m)
          return artcc === null ? { model: m } : saveSettings(m, { ...m.settings, eramView: { ...m.settings.eramView, [artcc.id]: { geoMap, filters } } })
        },
      }),
  })(model, { message, world: worldOf(model), artcc: artccOf(model) })

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
    CompletedLoadSettings: ({ settings: stored }) => {
      const settings = { ...stored, layouts: loadedLayouts(stored.layouts) }
      return {
        model: evo(model, { settings: () => settings, draft: () => settings }),
        commands: [ReadDeepLink(), ProbeRecognition()],
      }
    },

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
      const artcc = artccOf(model)
      const world: World = { ...makeWorld(airport, rulesFor(model.settings.mode), WORLD_SEED, artcc !== null && artcc.id === airport.artcc ? artcc : null), autoTrack: model.settings.autoTrack }
      const info = airportInfo(airport)
      const pavement = pavementFor(airport.asdex, airport.twrmap, model.settings.asdexCabMap)
      const radar = starsInit(model.stars, airport.artcc, airport.stars, positionFor(model.settings.mode).scopeRangeNm, model.settings.starsMaps[airport.id] ?? null)
      const eram = eramInit(model.eram, artcc !== null && artcc.id === airport.artcc ? artcc : null, positionFor('center').scopeRangeNm, model.settings.eramView[airport.artcc] ?? null)
      const fitted: Model = restartTimeline({
        ...model,
        airport: { _tag: 'Ready', info, world },
        pavement: pavement === null ? Pavement.None() : Pavement.Loading({ id: pavement.id }),
        scope: fit(world.graph, { ...model.scope, fitted: false }),
        stars: radar.model,
        eram: eram.model,
      })
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
          ...Command.mapMessages(eram.commands, (message) => Message.GotEram({ message })),
        ],
      }
    },

    FailedLoadAirport: ({ id, error }) => ({ model: evo(model, { airport: () => AirportLoad.Failed({ id, error }) }) }),

    /** The ARTCC file: kept for the airport about to load; a World already made without it takes its nav and sectors. */
    CompletedLoadArtcc: ({ artcc }) => {
      if (model.artcc._tag === 'Loading' && model.artcc.id !== artcc.id) {
        return { model }
      }
      const ready = evo(model, { artcc: () => ArtccLoad.Ready({ artcc }) })
      const world = worldOf(ready)
      const info = infoOf(ready)
      if (world !== null && info !== null && info.artcc === artcc.id) {
        const merged = withWorldChange(ready, withArtcc(world, artcc, null), `${artcc.id} ERAM data`)
        const eram = eramInit(merged.eram, artcc, positionFor('center').scopeRangeNm, merged.settings.eramView[artcc.id] ?? null)
        return { model: evo(merged, { eram: () => eram.model }), commands: Command.mapMessages(eram.commands, (message) => Message.GotEram({ message })) }
      }
      return afterArtcc(ready)
    },

    FailedLoadArtcc: ({ id, error }) => afterArtcc(pushLog(evo(model, { artcc: () => ArtccLoad.Failed({ id, error }) }), 'sys', null, `no ERAM data for ${id} (${error}) — the Center position has no GeoMaps here`)),

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
      if (world === null || isReviewing(model)) {
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
      const applied = applyEvents(evo(withWorld(clocked, stepped.world), { timeline: (t) => recordSteps(t, stepped.world) }), stepped.events)
      return { model: applied.model, commands: [...applied.commands, ...broadcast(model, SessionEvent.Stepped({ steps }))] }
    },

    ChangedPosition: ({ mode }) => control(model, SessionControl.SetPosition({ mode })),

    /** The Scenarios pane browses an ARTCC without loading anything; an airport click loads that airport. */
    ChangedArtcc: ({ id }) => ({ model: evo(model, { browseArtcc: () => id }) }),

    ChangedAirport: ({ id }) => startLoadingAirport(evo(model, { browseArtcc: () => null }), id),

    ChangedScenario: ({ id }) =>
      isGuest(model)
        ? { model, commands: [SendSession({ event: SessionEvent.RequestedScenario({ scenarioId: id === '' ? null : id }), target: model.session.hostId })] }
        : selectScenario(model, id === '' ? null : id),

    ClickedTogglePlay: () => control(model, SessionControl.SetRunning({ running: !model.running })),

    /** 0× pauses; another rate is applied and, when paused, runs the sim (rewound, that forks like the play button) */
    ChangedRate: ({ rate }) => {
      if (rate <= 0) {
        return model.running ? control(model, SessionControl.SetRunning({ running: false })) : { model }
      }
      const set = rate === model.rate ? { model } : control(model, SessionControl.SetRate({ rate }))
      if (model.running) {
        return set
      }
      const run = control(set.model, SessionControl.SetRunning({ running: true }))
      return { model: run.model, commands: [...(set.commands ?? []), ...(run.commands ?? [])] }
    },

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

    /** A click: on a proposed route, a runway crossing toggles hold short / cross, an entry marker picks where to enter the runway and an intersection reroutes; else an aircraft selects, and empty pavement closes the ring. */
    ReleasedScope: ({ x, y }) => {
      const drag = model.drag
      const world = worldOf(model)
      const released = evo(model, { drag: () => null })
      if (drag === null || drag.moved || world === null) {
        return { model: released }
      }
      const graph = world.graph
      const open = model.selected === model.radial?.callsign ? openPlan(world, model.settings.mode, model.radial) : null
      if (open !== null) {
        const crossing = hitTest(graph, model.scope, x, y, open.preview.crossings, (c) => graph.nodes[c.node]!)
        if (crossing !== null) {
          return pickRadial(released, `x:${crossing.runway}`)
        }
        const entry = hitTest(graph, model.scope, x, y, runwayEntries(graph, open.plan.runway), (e) => graph.nodes[e.node]!, INTERSECTION_HIT_FRACTION)
        if (entry !== null) {
          return pickRadial(released, `e:${entry.taxiway}`)
        }
        const node = hitTest(graph, model.scope, x, y, intersections(graph), (n) => graph.nodes[n]!, INTERSECTION_HIT_FRACTION)
        if (node !== null) {
          return pickRadial(released, `n:${node}`)
        }
      }
      const hit = hitTest(graph, model.scope, x, y, world.aircraft.filter((a) => a.delay <= 0), (a) => a.position)
      return hit === null
        ? { model: open === null ? evo(released, { radial: () => null }) : released }
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
        : { model: evo(released, { selected: () => hit.callsign, radial: () => ({ pane: 'asdex' as const, callsign: hit.callsign, trail: [] }) }), commands: [FocusCommand()] }
    },

    PickedRadial: ({ key }) => pickRadial(model, key),

    PickedRunwayButton: ({ designator }) => {
      const radial = model.radial
      const world = worldOf(model)
      const aircraft = radial === null || world === null ? undefined : findAircraft(world, radial.callsign)
      if (radial === null || world === null || aircraft === undefined) {
        return { model }
      }
      const node = radialAt(world, model.settings.mode, aircraft, radial.trail)
      const keys = node === null ? null : runwayPickTrail(node, designator)
      return keys === null ? { model } : { model: evo(model, { radial: () => ({ ...radial, trail: [...radial.trail, ...keys] }) }) }
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

    ClickedHelp: () => openWindow(model, 'commands'),

    ClickedSettings: () => openWindow(model, 'settings'),

    // WINDOWS

    ToggledWindow: ({ panel }) => toggleWindow(model, panel),

    ClosedWindow: ({ panel }) => closeWindow(model, panel),

    ToggledFloat: ({ panel }) => persistLayout(withLayout(model, (l) => toggleFloat(l, panel, model.workspace))),

    ToggledFullscreen: ({ panel }) => ({ model: evo(model, { fullscreen: (f) => (f === panel ? null : panel) }) }),

    ExitedFullscreen: () => ({ model: evo(model, { fullscreen: () => null }) }),

    FocusedWindow: ({ panel }) => ({ model: placement(activeLayout(model), panel) === 'floating' ? withLayout(model, (l) => raise(l, panel)) : model }),

    ClickedResetLayout: () => {
      const layouts = { ...model.settings.layouts, [model.settings.mode]: defaultLayouts[model.settings.mode] }
      return persistLayout(evo(model, { settings: (s) => ({ ...s, layouts }), draft: (d) => ({ ...d, layouts }), fullscreen: () => null, windowDrag: () => null }))
    },

    ResizedWorkspace: ({ width, height }) => ({
      model: withLayout(evo(model, { workspace: () => ({ width, height }) }), (l) => fitFloating(l, { width, height })),
    }),

    DraggedHandle: (drag) => dragHandle(model, drag),

    UpdatedDraft: ({ draft }) => ({ model: evo(model, { draft: () => draft }) }),

    ClickedSaveSettings: () => {
      const d = model.draft
      const settings: Settings = {
        ...d,
        key: d.key.trim() || defaultSettings.key,
        model: d.model.trim() || defaultSettings.model,
        audioModel: d.audioModel.trim() || defaultSettings.audioModel,
        ttsModel: d.ttsModel.trim() || defaultSettings.ttsModel,
        proxy: d.proxy.trim(),
      }
      const saved = withLayout(evo(model, { settings: () => settings, draft: () => settings }), (l) => close(l, 'settings'))
      const warning = keyWarning(settings.key)
      const logged = pushLog(
        warning === null ? saved : pushLog(saved, 'err', null, warning),
        'sys',
        null,
        aiEnabled(settings) ? `plain-English commands on via OpenRouter (${settings.model})` : 'plain-English commands off — command syntax only',
      )
      const proxyChanged = settings.proxy !== model.settings.proxy
      /** the auto-track preference lives on the World too, so it travels with the session like the arrival generator */
      const tracked = settings.autoTrack !== model.settings.autoTrack ? control(logged, SessionControl.SetAutoTrack({ enabled: settings.autoTrack })) : { model: logged }
      return {
        model: proxyChanged ? evo(tracked.model, { index: () => IndexLoad.Loading(), airport: () => AirportLoad.Idle() }) : tracked.model,
        commands: [...(tracked.commands ?? []), SaveSettings({ settings: tracked.model.settings }), ...(proxyChanged ? [LoadIndex({ source: sourceForProxy(settings.proxy) })] : [])],
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

    /** STARS messages fold into the pane; a map toggle is remembered per airport (dropped again once the selection is the default one). */
    GotEram: ({ message }) => foldEram(model, message),

    GotStars: ({ message }) => {
      const info = infoOf(model)
      const folded = foldStars(info?.artcc ?? '')(model, { message, world: worldOf(model) })
      if (info === null || message._tag !== 'ToggledMap') {
        return folded
      }
      const shown = folded.model.stars.shown
      const { [info.id]: _, ...rest } = folded.model.settings.starsMaps
      const saved = saveSettings(folded.model, { ...folded.model.settings, starsMaps: isDefaultMaps(info.stars, shown) ? rest : { ...rest, [info.id]: shown } })
      return { model: saved.model, commands: [...(folded.commands ?? []), ...(saved.commands ?? [])] }
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

    // REWIND

    ClickedTimeline: () => toggleWindow(model, 'rewind'),

    ScrubbedTimeline: ({ fx, fy }) => {
      const point = pointAt(model.timeline, fx, fy)
      return point === null ? { model } : scrubTo(model, point.branch, point.tick)
    },

    SteppedTimeline: ({ steps }) => {
      const viewed = viewedPoint(model)
      return viewed === null ? { model } : scrubTo(model, viewed.branch, viewed.tick + steps)
    },

    JumpedTimeline: ({ to }) => {
      const viewed = viewedPoint(model)
      const branch = viewed === null ? undefined : branchOf(model.timeline, viewed.branch)
      if (viewed === null || branch === undefined) {
        return { model }
      }
      return scrubTo(model, viewed.branch, to === 'start' ? -Infinity : branch.endTick)
    },

    ClickedTimelineLive: () => goLive(model),

    ClickedTimelineResume: () => resumeHere(model),

    ClickedSession: () => openWindow(model, 'session'),

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
