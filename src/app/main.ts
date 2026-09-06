/**
 * Application harness: Model / Message / update / view over the pure domain. The
 * sim advances on a 10 Hz wall-clock tick (catching up at most 40 steps), every
 * command is recorded with the sim tick it was issued at, and SimEvents from the
 * domain become log lines here.
 */
import { Clock, Effect, Schema, Stream } from 'effect'
import { Command, Runtime, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { evo } from 'foldkit/struct'

import { AirportFile } from '../domain/catalog'
import { AtcCommand, executeCommand, parseCommandLine } from '../domain/commands'
import { written } from '../domain/phrase'
import { MAX_STEPS_PER_TICK, SIM_STEP_S, stepWorldTimes } from '../domain/physics'
import { GROUND_RULES } from '../domain/rules'
import { loadScenario } from '../domain/scenario'
import { SimEvent, World, makeWorld } from '../domain/world'
import { VnasData } from '../services/vnasData'
import { groundScope, project, viewportFor } from '../view/ground'

// MODEL

export const TICK_MS = SIM_STEP_S * 1000

export const Load = defineTaggedUnion({
  Loading: {},
  Failed: { error: Schema.String },
  Ready: { world: World },
})
export type Load = typeof Load.Type

export const LogLine = Schema.Struct({
  kind: Schema.Literals(['atc', 'pilot', 'sys', 'err']),
  time: Schema.Number,
  who: Schema.NullOr(Schema.String),
  text: Schema.String,
})
export type LogLine = typeof LogLine.Type

export const CommandRecord = Schema.Struct({
  tick: Schema.Number,
  callsign: Schema.NullOr(Schema.String),
  command: AtcCommand,
})
export type CommandRecord = typeof CommandRecord.Type

export const Model = Schema.Struct({
  load: Load,
  running: Schema.Boolean,
  rate: Schema.Number,
  /** wall-clock ms of the last tick consumed; null restarts the clock */
  lastTickAt: Schema.NullOr(Schema.Number),
  devicePixelRatio: Schema.Number,
  selected: Schema.NullOr(Schema.String),
  commandText: Schema.String,
  log: Schema.Array(LogLine),
  /** every executed command with the sim tick it was issued at; replays a session */
  commandLog: Schema.Array(CommandRecord),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  CompletedLoadAirport: { airport: AirportFile },
  FailedLoadAirport: { error: Schema.String },
  Ticked: { now: Schema.Number },
  ClickedTogglePlay: {},
  ClickedRate: { rate: Schema.Number },
  ClickedArrivals: {},
  ClickedScope: { x: Schema.Number, y: Schema.Number },
  UpdatedCommandText: { value: Schema.String },
  SubmittedCommand: {},
  IssuedCommand: { callsign: Schema.NullOr(Schema.String), command: AtcCommand },
})
export type Message = typeof Message.Type

// INIT

export const initialModel: Model = {
  load: Load.Loading(),
  running: true,
  rate: 1,
  lastTickAt: null,
  devicePixelRatio: 1,
  selected: null,
  commandText: '',
  log: [],
  commandLog: [],
}

export const init: Runtime.ApplicationInit<Model, Message, void, VnasData> = () => ({
  model: { ...initialModel, devicePixelRatio: globalThis.devicePixelRatio ?? 1 },
  commands: [LoadAirport({ id: 'MSP', artcc: 'ZMP' })],
})

// COMMAND

export const LoadAirport = Command.define('LoadAirport', {
  args: { id: Schema.String, artcc: Schema.String },
  messages: [Message.CompletedLoadAirport, Message.FailedLoadAirport],
  execute: ({ id, artcc }) =>
    Effect.gen(function* () {
      const data = yield* VnasData
      const airport = yield* data.airport(id, artcc)
      return Message.CompletedLoadAirport({ airport })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.FailedLoadAirport({ error: e.message })))),
})

// UPDATE

const worldOf = (model: Model): World | null => (model.load._tag === 'Ready' ? model.load.world : null)

const withWorld = (model: Model, world: World): Model => evo(model, { load: () => Load.Ready({ world }) })

const pushLog = (model: Model, kind: LogLine['kind'], who: string | null, text: string): Model =>
  evo(model, {
    log: (log) => [{ kind, time: worldOf(model)?.simTime ?? 0, who, text }, ...log].slice(0, 140),
  })

export const applyEvents = (model: Model, events: ReadonlyArray<SimEvent>): Model =>
  events.reduce(
    (m, event) =>
      SimEvent.match(event, {
        PilotSaid: ({ callsign, phrase }) => pushLog(m, 'pilot', callsign, written(phrase)),
        SystemNote: ({ text }) => pushLog(m, 'sys', null, text),
        Removed: ({ callsign, text }) =>
          pushLog(evo(m, { selected: (s) => (s === callsign ? null : s) }), 'sys', null, text),
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
  const recorded = evo(withWorld(model, result.world), {
    commandLog: (log) => [...log, { tick: world.tick, callsign, command }],
  })
  return applyEvents(recorded, result.events)
}

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, VnasData>>(message, {
    CompletedLoadAirport: ({ airport }) => {
      const world = makeWorld(airport, GROUND_RULES, 20260906)
      const scenario = airport.scen.reduce<AirportFile['scen'][number] | null>(
        (best, s) => (best === null || s.ac.length > best.ac.length ? s : best),
        null,
      )
      const loaded = loadScenario(world, scenario)
      return { model: applyEvents(withWorld(model, loaded.world), loaded.events) }
    },

    FailedLoadAirport: ({ error }) => ({
      model: pushLog(evo(model, { load: () => Load.Failed({ error }) }), 'err', null, error),
    }),

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

    ClickedTogglePlay: () => ({ model: evo(model, { running: (r) => !r, lastTickAt: () => null }) }),

    ClickedRate: ({ rate }) => ({ model: evo(model, { rate: () => rate }) }),

    ClickedArrivals: () => {
      const world = worldOf(model)
      return { model: world === null ? model : withWorld(model, { ...world, arrivalsEnabled: !world.arrivalsEnabled }) }
    },

    ClickedScope: ({ x, y }) => {
      const world = worldOf(model)
      if (world === null) {
        return { model }
      }
      const vp = viewportFor(world.graph)
      const cx = x / model.devicePixelRatio
      const cy = y / model.devicePixelRatio
      const hit = world.aircraft
        .filter((a) => a.delay <= 0)
        .map((a) => {
          const p = project(world.graph, vp, a.position)
          return { callsign: a.callsign, d: Math.hypot(p.x - cx, p.y - cy) }
        })
        .filter((h) => h.d < 16)
        .sort((a, b) => a.d - b.d)[0]
      return { model: evo(model, { selected: () => hit?.callsign ?? null }) }
    },

    UpdatedCommandText: ({ value }) => ({ model: evo(model, { commandText: () => value }) }),

    SubmittedCommand: () => {
      const world = worldOf(model)
      const text = model.commandText
      if (world === null || text.trim() === '') {
        return { model: evo(model, { commandText: () => '' }) }
      }
      const entered = pushLog(evo(model, { commandText: () => '' }), 'atc', null, text)
      const parsed = parseCommandLine(world, model.selected, text)
      if (parsed._tag === 'Empty') {
        return { model: entered }
      }
      if (parsed._tag === 'Unknown') {
        return { model: pushLog(entered, 'err', null, 'not a command — AI translation arrives in Phase 5') }
      }
      const selected = evo(entered, { selected: (s) => parsed.callsign ?? s })
      if (parsed._tag === 'Invalid') {
        return { model: pushLog(selected, 'err', parsed.callsign, `unable — ${parsed.error}`) }
      }
      return { model: runCommand(selected, parsed.callsign, parsed.command) }
    },

    IssuedCommand: ({ callsign, command }) => ({ model: runCommand(model, callsign, command) }),
  })

// SUBSCRIPTION

export const subscriptions = Subscription.make<Model, Message, VnasData>()((entry) => ({
  tick: entry(
    { isActive: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isActive: model.running && model.load._tag === 'Ready' }),
      dependenciesToStream: ({ isActive }) =>
        isActive
          ? Stream.tick(`${TICK_MS} millis`).pipe(
              Stream.mapEffect(() => Clock.currentTimeMillis),
              Stream.map((now) => Message.Ticked({ now })),
            )
          : Stream.empty,
    },
  ),
}))

// VIEW

const clock = (seconds: number): string =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

const rateButton = (model: Model, rate: number, h: HtmlBuilder<Message>): Html =>
  h.button(
    [h.Class(model.rate === rate ? 'on' : ''), h.OnClick(Message.ClickedRate({ rate }))],
    [`${rate}x`],
  )

const headerView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const status = Load.match(model.load, {
    Loading: () => 'loading catalog…',
    Failed: ({ error }) => `failed: ${error}`,
    Ready: ({ world }) => `${world.airport.id} · ${world.aircraft.length} ac · ${clock(world.simTime)}`,
  })
  const arrivalsOn = worldOf(model)?.arrivalsEnabled ?? false
  return h.div(
    [h.Class('header')],
    [
      h.span([h.Class('brand')], ['vNAS Trainer']),
      h.span([h.Class('status')], [status]),
      h.button([h.OnClick(Message.ClickedTogglePlay())], [model.running ? 'Running' : 'Paused']),
      rateButton(model, 1, h),
      rateButton(model, 2, h),
      rateButton(model, 4, h),
      rateButton(model, 8, h),
      h.button([h.Class(arrivalsOn ? 'on' : ''), h.OnClick(Message.ClickedArrivals())], ['Arrivals']),
    ],
  )
}

const sideView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const world = worldOf(model)
  const strips = (world?.aircraft ?? []).map((a) =>
    h.div(
      [h.Class(`strip${a.callsign === model.selected ? ' sel' : ''}`)],
      [`${a.callsign} ${a.state}${a.delay > 0 ? ` +${Math.ceil(a.delay)}s` : ''}${a.state === 'AIRB' ? ` ${Math.round(a.altitude)}` : ''}`],
    ),
  )
  const lines = model.log.map((line) =>
    h.div([h.Class(`line ${line.kind}`)], [`${clock(line.time)} ${line.who !== null ? `${line.who} ` : ''}${line.text}`]),
  )
  return h.div([h.Class('side')], [h.div([h.Class('strips')], strips), h.div([h.Class('log')], lines)])
}

const scopeView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Load.match(model.load, {
    Loading: () => h.div([h.Class('scopeWrap')], ['loading…']),
    Failed: ({ error }) => h.div([h.Class('scopeWrap')], [error]),
    Ready: ({ world }) =>
      h.div(
        [h.Class('scopeWrap')],
        [
          groundScope(
            {
              graph: world.graph,
              aircraft: world.aircraft,
              selected: model.selected,
              devicePixelRatio: model.devicePixelRatio,
              onPointerDown: ({ x, y }) => Message.ClickedScope({ x, y }),
            },
            h,
          ),
        ],
      ),
  })

const commandView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Class('cmd'), h.OnSubmit(Message.SubmittedCommand())],
    [
      h.span([h.Class('sel')], [model.selected ?? '—']),
      h.input([
        h.Value(model.commandText),
        h.Placeholder('DAL1234 PUSH · RWY 30L TAXI A B · CROSS · LUAW · CTO'),
        h.OnInput((value) => Message.UpdatedCommandText({ value })),
      ]),
      h.button([], ['Send']),
    ],
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'vNAS Trainer',
  body: h.div(
    [h.Class('app')],
    [
      headerView(model, h),
      h.div([h.Class('main')], [scopeView(model, h), sideView(model, h)]),
      commandView(model, h),
    ],
  ),
})
