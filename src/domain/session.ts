/**
 * Shared sessions (docs/REWRITE.md Phase 7): the wire protocol between peers.
 * The host owns the clock and the authoritative World; every peer, host
 * included, sends commands as requests and applies them from the host's
 * broadcast, so all copies stay identical. Everything here is Schema data.
 */
import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { AtcCommand } from './commands'
import { World } from './world'

export const PositionMode = Schema.Literals(['ground', 'tower', 'tracon'])

/** Session-wide state changes that are not aircraft commands. */
export const SessionControl = defineTaggedUnion({
  SetRunning: { running: Schema.Boolean },
  SetRate: { rate: Schema.Number },
  SetArrivals: { enabled: Schema.Boolean },
  SetPosition: { mode: PositionMode },
})
export type SessionControl = typeof SessionControl.Type

export const Snapshot = Schema.Struct({
  airportId: Schema.String,
  artcc: Schema.String,
  scenarioId: Schema.NullOr(Schema.String),
  world: World,
  running: Schema.Boolean,
  rate: Schema.Number,
  mode: PositionMode,
})
export type Snapshot = typeof Snapshot.Type

export const SessionEvent = defineTaggedUnion({
  /** host → a joining peer, and host → all after a scenario or position change */
  Snapshot: { snapshot: Snapshot },
  /** host → all after each tick */
  Stepped: { steps: Schema.Number },
  /** host → all, in execution order; `said` is the typed line for the log */
  Commanded: { callsign: Schema.NullOr(Schema.String), command: AtcCommand, said: Schema.NullOr(Schema.String) },
  /** host → all */
  Controlled: { control: SessionControl },
  /** any peer → host */
  RequestedCommand: { callsign: Schema.NullOr(Schema.String), command: AtcCommand, said: Schema.NullOr(Schema.String) },
  RequestedControl: { control: SessionControl },
  RequestedScenario: { scenarioId: Schema.NullOr(Schema.String) },
})
export type SessionEvent = typeof SessionEvent.Type

export const encodeSessionEvent = Schema.encodeSync(SessionEvent)
export const decodeSessionEvent = Schema.decodeUnknownSync(SessionEvent)

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LENGTH = 6

export const isRoomCode = (s: string): boolean => new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`).test(s)

export const normaliseRoomCode = (s: string): string => s.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/I/g, '1')
