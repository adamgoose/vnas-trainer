/**
 * The application Model. The simulation itself is the `World` inside
 * `airport`; everything else is UI state, loading state, settings, and the
 * replayable command log.
 */
import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { ArtccFile, CatalogIndex, Stars } from '../domain/catalog'
import { Snapshot } from '../domain/session'
import { World } from '../domain/world'
import { Edge, Panel, Size } from './layout'
import { CommandRecord, LogLine } from './log'
import { Review, Timeline, emptyTimeline } from './timeline'
import { EramModel, initialEram } from '../positions/center/eram'
import { StarsModel, initialStars } from '../positions/local/stars'
import { Settings, defaultSettings } from '../services/settings'

export { CommandRecord, LogLine } from './log'

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

/** The ARTCC file (Phase 9): loaded before the airport so the World gets its nav and sectors; a failure is tolerated. */
export const ArtccLoad = defineTaggedUnion({
  Idle: {},
  Loading: { id: Schema.String },
  Failed: { id: Schema.String, error: Schema.String },
  Ready: { artcc: ArtccFile },
})
export type ArtccLoad = typeof ArtccLoad.Type

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

/** The radial command menu open on a scope: which pane drew it, which aircraft, and the keys picked so far. */
export const RadialPane = Schema.Literals(['asdex', 'stars'])
export type RadialPane = typeof RadialPane.Type
export const Radial = Schema.Struct({ pane: RadialPane, callsign: Schema.String, trail: Schema.Array(Schema.String) })
export type Radial = typeof Radial.Type

/** A window being dragged by its title bar: where the press was, where a floating window started, and the tile under the pointer. */
export const WindowDrag = Schema.Struct({
  panel: Panel,
  startX: Schema.Number,
  startY: Schema.Number,
  originX: Schema.Number,
  originY: Schema.Number,
  moved: Schema.Boolean,
  over: Schema.NullOr(Panel),
  edge: Schema.NullOr(Edge),
})
export type WindowDrag = typeof WindowDrag.Type

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

/** A pilot transmission that arrived while the controller's mic was keyed. */
export const HeldSpeech = Schema.Struct({ callsign: Schema.String, text: Schema.String })
export type HeldSpeech = typeof HeldSpeech.Type

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
  /** the ARTCC shown in the Scenarios pane; null follows the loaded airport */
  browseArtcc: Schema.NullOr(Schema.String),
  pavement: Pavement,
  scope: ScopeView,
  drag: Schema.NullOr(Drag),
  radial: Schema.NullOr(Radial),
  /** the ASDE-X display panel (DISP) is open */
  asdexPanelOpen: Schema.Boolean,
  stars: StarsModel,
  artcc: ArtccLoad,
  eram: EramModel,
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
  /** the session's time graph: keyframes per branch (timeline.ts) */
  timeline: Timeline,
  /** the point of the graph shown instead of the present; the sim is paused while set */
  review: Schema.NullOr(Review),
  /** the workspace (the area under the bar) in CSS px */
  workspace: Size,
  windowDrag: Schema.NullOr(WindowDrag),
  /** a window filling the workspace on its own */
  fullscreen: Schema.NullOr(Panel),
  draft: Settings,
  settingsStatus: SettingsStatus,
  /** OpenRouter model lists once loaded in Settings */
  models: Schema.NullOr(ModelCatalogue),
  browserVoices: Schema.Array(BrowserVoice),
  ptt: PttState,
  /** pilot lines that came up under a keyed mic; spoken in order once it un-keys */
  heldSpeech: Schema.Array(HeldSpeech),
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
  browseArtcc: null,
  pavement: Pavement.None(),
  scope: { width: 800, height: 600, scale: 0.05, originX: 0, originY: 0, fitted: false },
  drag: null,
  radial: null,
  asdexPanelOpen: false,
  stars: initialStars,
  artcc: ArtccLoad.Idle(),
  eram: initialEram,
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
  timeline: emptyTimeline,
  review: null,
  workspace: { width: 0, height: 0 },
  windowDrag: null,
  fullscreen: null,
  draft: defaultSettings,
  settingsStatus: { text: '', kind: '' },
  models: null,
  browserVoices: [],
  ptt: 'idle',
  heldSpeech: [],
  pendingAi: null,
  recognitionAvailable: false,
  session: initialSession,
}

export const isHost = (model: Model): boolean => model.session.role === 'host'
export const isGuest = (model: Model): boolean => model.session.role === 'guest'

export const isReviewing = (model: Model): boolean => model.review !== null

export const worldOf = (model: Model): World | null => (model.airport._tag === 'Ready' ? model.airport.world : null)
export const artccOf = (model: Model): ArtccFile | null => (model.artcc._tag === 'Ready' ? model.artcc.artcc : null)
export const infoOf = (model: Model): AirportInfo | null => (model.airport._tag === 'Ready' ? model.airport.info : null)
