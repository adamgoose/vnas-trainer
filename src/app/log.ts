/**
 * What a session records as it runs: the log lines the deck shows and the
 * replayable command log. Both are kept per branch of the time graph
 * (timeline.ts), so they live here rather than in model.ts.
 */
import { Schema } from 'effect'

import { AtcCommand } from '../domain/commands'

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
