/**
 * The application Model. The simulation itself is the `World` inside
 * `airport`; everything else is UI state, loading state, settings, and the
 * replayable command log.
 */
import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { CatalogIndex } from '../domain/catalog'
import { AtcCommand } from '../domain/commands'
import { World } from '../domain/world'
import { Settings, defaultSettings } from '../services/settings'

export const IndexLoad = defineTaggedUnion({
  Loading: {},
  Failed: { error: Schema.String },
  Ready: { index: CatalogIndex },
})
export type IndexLoad = typeof IndexLoad.Type

export const ScenarioSummary = Schema.Struct({ id: Schema.String, name: Schema.String, count: Schema.Number })
export type ScenarioSummary = typeof ScenarioSummary.Type

export const AirportInfo = Schema.Struct({
  id: Schema.String,
  artcc: Schema.String,
  name: Schema.String,
  asdex: Schema.NullOr(Schema.String),
  twrmap: Schema.NullOr(Schema.String),
  scenarios: Schema.Array(ScenarioSummary),
})
export type AirportInfo = typeof AirportInfo.Type

export const AirportLoad = defineTaggedUnion({
  Idle: {},
  Loading: { id: Schema.String },
  Failed: { id: Schema.String, error: Schema.String },
  Ready: { info: AirportInfo, world: World },
})
export type AirportLoad = typeof AirportLoad.Type

export const Pavement = defineTaggedUnion({
  None: {},
  Loading: { id: Schema.String },
  Ready: { id: Schema.String, asdex: Schema.Boolean },
  Failed: { error: Schema.String },
})
export type Pavement = typeof Pavement.Type

/** The ground scope's viewport: canvas size in CSS px, feet per px, and the world point at the top-left. */
export const ScopeView = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
  /** canvas px per foot */
  scale: Schema.Number,
  originX: Schema.Number,
  originY: Schema.Number,
  fitted: Schema.Boolean,
})
export type ScopeView = typeof ScopeView.Type

export const Drag = Schema.Struct({
  startX: Schema.Number,
  startY: Schema.Number,
  originX: Schema.Number,
  originY: Schema.Number,
  moved: Schema.Boolean,
})
export type Drag = typeof Drag.Type

export const LogLine = Schema.Struct({
  kind: Schema.Literals(['atc', 'pilot', 'sys', 'err', 'ai']),
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

export const Dialog = Schema.Literals(['none', 'help', 'settings'])
export type Dialog = typeof Dialog.Type

export const DeepLink = Schema.Struct({ airport: Schema.NullOr(Schema.String), scenario: Schema.NullOr(Schema.String) })
export type DeepLink = typeof DeepLink.Type

export const Model = Schema.Struct({
  settings: Settings,
  deepLink: DeepLink,
  index: IndexLoad,
  airport: AirportLoad,
  /** scenario id being fetched (live mode) */
  scenarioLoading: Schema.NullOr(Schema.String),
  pavement: Pavement,
  scope: ScopeView,
  drag: Schema.NullOr(Drag),
  devicePixelRatio: Schema.Number,
  running: Schema.Boolean,
  rate: Schema.Number,
  /** wall-clock ms of the last tick consumed; null restarts the clock */
  lastTickAt: Schema.NullOr(Schema.Number),
  selected: Schema.NullOr(Schema.String),
  commandText: Schema.String,
  history: Schema.Array(Schema.String),
  historyIndex: Schema.Number,
  log: Schema.Array(LogLine),
  /** every executed command with the sim tick it was issued at; replays a session */
  commandLog: Schema.Array(CommandRecord),
  dialog: Dialog,
  draft: Settings,
  settingsStatus: Schema.String,
})
export type Model = typeof Model.Type

export const initialModel: Model = {
  settings: defaultSettings,
  deepLink: { airport: null, scenario: null },
  index: IndexLoad.Loading(),
  airport: AirportLoad.Idle(),
  scenarioLoading: null,
  pavement: Pavement.None(),
  scope: { width: 800, height: 600, scale: 0.05, originX: 0, originY: 0, fitted: false },
  drag: null,
  devicePixelRatio: 1,
  running: true,
  rate: 1,
  lastTickAt: null,
  selected: null,
  commandText: '',
  history: [],
  historyIndex: -1,
  log: [],
  commandLog: [],
  dialog: 'none',
  draft: defaultSettings,
  settingsStatus: '',
}

export const worldOf = (model: Model): World | null => (model.airport._tag === 'Ready' ? model.airport.world : null)
export const infoOf = (model: Model): AirportInfo | null => (model.airport._tag === 'Ready' ? model.airport.info : null)
