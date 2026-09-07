/**
 * The application Model. The simulation itself is the `World` inside
 * `airport`; everything else is UI state, loading state, settings, and the
 * replayable command log.
 */
import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { CatalogIndex, Stars } from '../domain/catalog'
import { Snapshot } from '../domain/session'
import { AtcCommand } from '../domain/commands'
import { World } from '../domain/world'
import { StarsModel, initialStars } from '../positions/local/stars'
import { Settings, defaultSettings } from '../services/settings'

export const IndexLoad = defineTaggedUnion({
  Loading: {},
  Failed: { error: Schema.String },
  Ready: { index: CatalogIndex },
})
export type IndexLoad = typeof IndexLoad.Type

export const ScenarioSummary = Schema.Struct({ id: Schema.String, name: Schema.String, count: Schema.Number, surface: Schema.Number, airborne: Schema.Number })
export type ScenarioSummary = typeof ScenarioSummary.Type

export const AirportInfo = Schema.Struct({
  id: Schema.String,
  artcc: Schema.String,
  name: Schema.String,
  asdex: Schema.NullOr(Schema.String),
  twrmap: Schema.NullOr(Schema.String),
  stars: Schema.NullOr(Stars),
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

export const Dialog = Schema.Literals(['none', 'help', 'settings', 'session'])
export type Dialog = typeof Dialog.Type

export const DeepLink = Schema.Struct({
  airport: Schema.NullOr(Schema.String),
  scenario: Schema.NullOr(Schema.String),
  /** a session room code from a `#join/CODE` link */
  room: Schema.NullOr(Schema.String),
})
export type DeepLink = typeof DeepLink.Type

export const SessionRole = Schema.Literals(['solo', 'host', 'guest'])
export type SessionRole = typeof SessionRole.Type

export const SessionState = Schema.Struct({
  role: SessionRole,
  room: Schema.NullOr(Schema.String),
  status: Schema.Literals(['idle', 'connecting', 'connected', 'failed']),
  error: Schema.NullOr(Schema.String),
  peers: Schema.Array(Schema.String),
  /** the peer whose snapshots and steps we follow (guests) */
  hostId: Schema.NullOr(Schema.String),
  /** a snapshot waiting for its airport to load (guests) */
  pendingSnapshot: Schema.NullOr(Snapshot),
  roomInput: Schema.String,
})
export type SessionState = typeof SessionState.Type

export const initialSession: SessionState = { role: 'solo', room: null, status: 'idle', error: null, peers: [], hostId: null, pendingSnapshot: null, roomInput: '' }

export const PttState = Schema.Literals(['idle', 'tx', 'busy', 'listen'])
export type PttState = typeof PttState.Type

export const ModelCatalogue = Schema.Struct({
  ids: Schema.Array(Schema.String),
  audioIds: Schema.Array(Schema.String),
  speech: Schema.Record(Schema.String, Schema.NullOr(Schema.Array(Schema.String))),
})
export type ModelCatalogue = typeof ModelCatalogue.Type

export const BrowserVoice = Schema.Struct({ name: Schema.String, lang: Schema.String })
export type BrowserVoice = typeof BrowserVoice.Type

export const SettingsStatus = Schema.Struct({ text: Schema.String, kind: Schema.Literals(['', 'ok', 'bad']) })
export type SettingsStatus = typeof SettingsStatus.Type

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
  stars: StarsModel,
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
  settingsStatus: SettingsStatus,
  /** OpenRouter model lists once loaded in Settings */
  models: Schema.NullOr(ModelCatalogue),
  browserVoices: Schema.Array(BrowserVoice),
  ptt: PttState,
  /** the transient "translating…" line shown at the top of the log */
  pendingAi: Schema.NullOr(Schema.String),
  recognitionAvailable: Schema.Boolean,
  session: SessionState,
})
export type Model = typeof Model.Type

export const initialModel: Model = {
  settings: defaultSettings,
  deepLink: { airport: null, scenario: null, room: null },
  index: IndexLoad.Loading(),
  airport: AirportLoad.Idle(),
  scenarioLoading: null,
  pavement: Pavement.None(),
  scope: { width: 800, height: 600, scale: 0.05, originX: 0, originY: 0, fitted: false },
  drag: null,
  stars: initialStars,
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
  settingsStatus: { text: '', kind: '' },
  models: null,
  browserVoices: [],
  ptt: 'idle',
  pendingAi: null,
  recognitionAvailable: false,
  session: initialSession,
}

export const isHost = (model: Model): boolean => model.session.role === 'host'
export const isGuest = (model: Model): boolean => model.session.role === 'guest'

export const worldOf = (model: Model): World | null => (model.airport._tag === 'Ready' ? model.airport.world : null)
export const infoOf = (model: Model): AirportInfo | null => (model.airport._tag === 'Ready' ? model.airport.info : null)
