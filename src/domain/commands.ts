/**
 * Controller commands (docs/REWRITE.md section 5, "Commands"): the command union,
 * the line parser and the executor. Executing a command is a pure function of the
 * World; the pilot's readback comes back as a SimEvent.
 */
import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { type Aircraft, handoffAccepted } from './aircraft'
import type { LonLat } from './catalog'
import { distanceFt } from './geo'
import { type Graph, departureHold, edgeName, isRunwayName, nearestNode, nearestOn, runwaysEntered } from './graph'
import {
  type Phrase,
  type PhrasePart,
  type PhraseToken,
  altitudeWords,
  callsign as callsignToken,
  digits,
  fix as fixToken,
  frequency,
  gate as gateToken,
  phrase,
  runway as runwayToken,
  taxiways,
} from './phrase'
import { armHold, autoExit, goAround, holdTarget, withPath } from './physics'
import { PUSHBACK_RUNWAY_PENALTY_FT, findPath, routeVia } from './route'
import { nextInt } from './prng'
import {
  SimEvent,
  type World,
  type WorldResult,
  approachRadioName,
  findAircraft,
  matchCallsign,
  nextFacility,
  removeAircraft,
  replaceAircraft,
  towerRadioName,
} from './world'

// COMMAND

export const AtcCommand = defineTaggedUnion({
  Push: { taxiway: Schema.NullOr(Schema.String) },
  Taxi: { via: Schema.Array(Schema.String), cross: Schema.Array(Schema.String), holdShort: Schema.NullOr(Schema.String) },
  /** `at` names the taxiway of an intersection departure; null is full length */
  Runway: { runway: Schema.String, at: Schema.NullOr(Schema.String), via: Schema.Array(Schema.String), cross: Schema.Array(Schema.String), holdShort: Schema.NullOr(Schema.String) },
  HoldShort: { point: Schema.String },
  Cross: { runway: Schema.NullOr(Schema.String) },
  Resume: {},
  Hold: {},
  Break: {},
  GiveWay: { callsign: Schema.String },
  TaxiAll: {},
  LineUpAndWait: { at: Schema.NullOr(Schema.String) },
  ClearedForTakeoff: { heading: Schema.NullOr(Schema.Number), turn: Schema.NullOr(Schema.Literals(['L', 'R'])), at: Schema.NullOr(Schema.String) },
  Exit: {},
  GoAround: {},
  ClearedToLand: {},
  Track: {},
  Drop: {},
  ContactDeparture: {},
  FlyHeading: { heading: Schema.Number, turn: Schema.NullOr(Schema.Literals(['L', 'R'])) },
  ClimbMaintain: { altitude: Schema.Number },
  /** TRACON (Phase 8) */
  Direct: { fix: Schema.String },
  Speed: { knots: Schema.NullOr(Schema.Number) },
  ExpectRunway: { runway: Schema.String },
  ClearedApproach: { runway: Schema.NullOr(Schema.String) },
  ContactTower: {},
  /** Center (Phase 9): the arrival is switched to the approach */
  ContactApproach: {},
  /** ERAM entries (Phase 9): data the controller keys into the flight plan; the pilot is told separately */
  AssignAltitude: { altitude: Schema.Number },
  InterimAltitude: { altitude: Schema.NullOr(Schema.Number) },
  SetHsf: { heading: Schema.NullOr(Schema.Number), speed: Schema.NullOr(Schema.Number), text: Schema.NullOr(Schema.String), clear: Schema.Literals(['none', 'heading', 'speed', 'all']) },
  AmendDirect: { fix: Schema.String },
  FlightPlanReadout: {},
  RequestBeacon: {},
  HandoffSector: { sector: Schema.String },
  RecallHandoff: {},
  Squawk: { code: Schema.String },
  SquawkNormal: {},
  SquawkStandby: {},
  Ident: {},
  Say: { what: Schema.String },
  Delete: {},
  Pause: {},
  Unpause: {},
  SimRate: { rate: Schema.Number },
})
export type AtcCommand = typeof AtcCommand.Type

export const isGlobalCommand = (c: AtcCommand): boolean =>
  c._tag === 'Pause' || c._tag === 'Unpause' || c._tag === 'TaxiAll' || c._tag === 'SimRate'

// PARSER

/** ERAM display entries (Phase 9): they change the picture, not the World, so the app routes them to the ERAM pane. */
export const DisplayCommand = defineTaggedUnion({
  /** `<FLID>`: an LDB becomes an FDB and back */
  ToggleBlock: {},
  /** `<1-9> <FLID>`, `/<0-3> <FLID>`, `<1-9>/<0-3> <FLID>` */
  PositionBlock: { position: Schema.NullOr(Schema.Number), leader: Schema.NullOr(Schema.Number) },
  /** `//<FLID>` */
  ToggleVci: {},
  /** `QP J <FLID>` */
  ToggleHalo: {},
  /** `QS <FLID>` */
  ToggleHsf: {},
  /** `QU [minutes] <FLID>` draws the route; `QU <FLID>` with a route shown clears it */
  RouteDisplay: { minutes: Schema.NullOr(Schema.Number) },
  /** `QU` */
  ClearRoutes: {},
  /** `MR [name]` */
  GeoMap: { name: Schema.NullOr(Schema.String) },
})
export type DisplayCommand = typeof DisplayCommand.Type

export type ParseResult =
  | Readonly<{ _tag: 'Parsed'; callsign: string | null; command: AtcCommand }>
  | Readonly<{ _tag: 'Display'; callsign: string | null; display: DisplayCommand }>
  | Readonly<{ _tag: 'Invalid'; callsign: string | null; error: string }>
  | Readonly<{ _tag: 'Unknown' }>
  | Readonly<{ _tag: 'Empty' }>

const VERBS = new Set([
  'PUSH', 'TAXI', 'RWY', 'HS', 'CROSS', 'RES', 'HOLD', 'BREAK', 'GIVEWAY', 'GW', 'TAXIALL', 'LUAW', 'CTO', 'EXIT', 'GA',
  'CTL', 'TRACK', 'IC', 'DROP', 'DT', 'CD', 'FH', 'TL', 'TR', 'CM', 'DM', 'DCT', 'PD', 'SPD', 'EXP', 'CAPP', 'ILS', 'CT', 'HO', 'CA',
  'SQ', 'SN', 'SS', 'ID', 'SAY', 'DEL', 'PAUSE', 'UNPAUSE', 'SIMRATE',
])

/** ERAM message-composition verbs (Phase 9): the flight id comes last, as ERAM has it. */
const ERAM_VERBS = new Set(['QZ', 'QQ', 'QS', 'QU', 'QT', 'QX', 'QF', 'QB', 'QP', 'AM', 'MR'])

export const isEramVerb = (token: string): boolean => ERAM_VERBS.has(token.toUpperCase())

export const isVerb = (token: string): boolean => VERBS.has(token.toUpperCase())

/** "50" and "FL050" both mean 5,000; values above 450 are feet. */
export const parseAltitude = (s: string | undefined): number | null => {
  const t = (s ?? '').toUpperCase()
  if (/^FL\d{2,3}$/.test(t)) {
    return parseInt(t.slice(2), 10) * 100
  }
  const n = parseInt(t, 10)
  if (!Number.isFinite(n) || n <= 0) {
    return null
  }
  return n <= 450 ? n * 100 : n
}

const parseHeading = (s: string | undefined): number | null => {
  const h = parseInt(s ?? '', 10)
  return Number.isFinite(h) && h >= 1 && h <= 360 ? h : null
}

type TaxiClauses = Readonly<{ via: ReadonlyArray<string>; cross: ReadonlyArray<string>; holdShort: string | null; at: string | null }>

/** `path [CROSS rwy...] [HS pt] [AT twy]` in any order: CROSS takes every token up to the next keyword, HS and AT one each. */
const splitClauses = (args: ReadonlyArray<string>): TaxiClauses => {
  const via: Array<string> = []
  const cross: Array<string> = []
  let holdShort: string | null = null
  let at: string | null = null
  let list = via
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!
    if (t === 'HS') {
      holdShort = args[i + 1] ?? null
      i++
      list = via
    } else if (t === 'AT') {
      at = args[i + 1] ?? null
      i++
      list = via
    } else if (t === 'CROSS') {
      list = cross
    } else {
      list.push(t)
    }
  }
  return { via, cross, holdShort, at }
}

/** `AT twy` taken out of a tower clearance's arguments: the intersection, and what is left. */
const splitAt = (args: ReadonlyArray<string>): Readonly<{ at: string | null; rest: ReadonlyArray<string> }> => {
  const i = args.indexOf('AT')
  if (i < 0) {
    return { at: null, rest: args }
  }
  return { at: args[i + 1] ?? null, rest: [...args.slice(0, i), ...args.slice(i + 2)] }
}

const TURN_WORDS: Readonly<Record<string, 'L' | 'R'>> = { L: 'L', TL: 'L', LEFT: 'L', R: 'R', TR: 'R', RIGHT: 'R' }

type Parsed = AtcCommand | Readonly<{ error: string }>

const parseVerb = (verb: string, args: ReadonlyArray<string>): Parsed => {
  const upper = args.map((a) => a.toUpperCase())
  switch (verb) {
    case 'PUSH':
      return AtcCommand.Push({ taxiway: upper[0] ?? null })
    case 'TAXI': {
      const { via, cross, holdShort } = splitClauses(upper)
      return via.length === 0 ? { error: 'taxi where?' } : AtcCommand.Taxi({ via, cross, holdShort })
    }
    case 'RWY': {
      const runway = upper[0]
      if (runway === undefined) {
        return { error: 'which runway?' }
      }
      // the word TAXI is optional, and may follow an AT clause: RWY 30L AT D TAXI A
      const rest = upper.slice(1).filter((t) => t !== 'TAXI')
      const { via, cross, holdShort, at } = splitClauses(rest)
      if (rest.includes('AT') && at === null) {
        return { error: 'at which taxiway?' }
      }
      return AtcCommand.Runway({ runway, at, via, cross, holdShort })
    }
    case 'HS':
      return upper[0] === undefined ? { error: 'hold short of what?' } : AtcCommand.HoldShort({ point: upper[0] })
    case 'CROSS':
      return AtcCommand.Cross({ runway: upper[0] ?? null })
    case 'RES':
      return AtcCommand.Resume()
    case 'HOLD':
      return AtcCommand.Hold()
    case 'BREAK':
      return AtcCommand.Break()
    case 'GIVEWAY':
    case 'GW':
      return upper[0] === undefined ? { error: 'give way to whom?' } : AtcCommand.GiveWay({ callsign: upper[0] })
    case 'TAXIALL':
      return AtcCommand.TaxiAll()
    case 'LUAW': {
      const { at } = splitAt(upper)
      return upper.includes('AT') && at === null ? { error: 'at which taxiway?' } : AtcCommand.LineUpAndWait({ at })
    }
    case 'CTO': {
      const { at, rest: args } = splitAt(upper)
      if (upper.includes('AT') && at === null) {
        return { error: 'at which taxiway?' }
      }
      if (args.length === 0) {
        return AtcCommand.ClearedForTakeoff({ heading: null, turn: null, at })
      }
      const turn = TURN_WORDS[args[0]!] ?? null
      const rest = turn !== null || args[0] === 'FH' ? args.slice(1) : args
      const heading = parseHeading(rest[0])
      return heading === null ? { error: 'heading?' } : AtcCommand.ClearedForTakeoff({ heading, turn, at })
    }
    case 'EXIT':
      return AtcCommand.Exit()
    case 'GA':
      return AtcCommand.GoAround()
    case 'CTL':
      return AtcCommand.ClearedToLand()
    case 'TRACK':
    case 'IC':
      return AtcCommand.Track()
    case 'DROP':
    case 'DT':
      return AtcCommand.Drop()
    case 'CD':
      return AtcCommand.ContactDeparture()
    case 'FH':
    case 'TL':
    case 'TR': {
      const heading = parseHeading(upper[0])
      if (heading === null) {
        return { error: 'heading?' }
      }
      return AtcCommand.FlyHeading({ heading, turn: verb === 'TL' ? 'L' : verb === 'TR' ? 'R' : null })
    }
    case 'CM':
    case 'DM': {
      const altitude = parseAltitude(upper[0])
      return altitude === null ? { error: 'altitude?' } : AtcCommand.ClimbMaintain({ altitude })
    }
    case 'DCT':
    case 'PD':
      return upper[0] === undefined ? { error: 'direct where?' } : AtcCommand.Direct({ fix: upper[0] })
    case 'SPD': {
      if (upper[0] === undefined) {
        return AtcCommand.Speed({ knots: null })
      }
      const knots = parseInt(upper[0], 10)
      return Number.isFinite(knots) && knots >= 100 && knots <= 400 ? AtcCommand.Speed({ knots }) : { error: 'speed?' }
    }
    case 'EXP':
      return upper[0] === undefined ? { error: 'expect which runway?' } : AtcCommand.ExpectRunway({ runway: upper[0] })
    case 'CAPP':
    case 'ILS':
      return AtcCommand.ClearedApproach({ runway: upper[0] ?? null })
    case 'CT':
    case 'HO':
      return AtcCommand.ContactTower()
    case 'CA':
      return AtcCommand.ContactApproach()
    case 'SQ':
      return upper[0] === undefined ? { error: 'squawk what?' } : AtcCommand.Squawk({ code: upper[0] })
    case 'SN':
      return AtcCommand.SquawkNormal()
    case 'SS':
      return AtcCommand.SquawkStandby()
    case 'ID':
      return AtcCommand.Ident()
    case 'SAY':
      return AtcCommand.Say({ what: upper[0] ?? '' })
    case 'DEL':
      return AtcCommand.Delete()
    case 'PAUSE':
      return AtcCommand.Pause()
    case 'UNPAUSE':
      return AtcCommand.Unpause()
    case 'SIMRATE':
      return AtcCommand.SimRate({ rate: Math.max(1, Math.min(8, parseInt(upper[0] ?? '1', 10) || 1)) })
    default:
      return { error: `unknown command ${verb}` }
  }
}

/** ERAM altitudes are hundreds of feet ("350" = FL350, "080" = 8,000); a plain foot value above 450 is taken as feet. */
const parseEramAltitude = (s: string | undefined): number | null => parseAltitude(s)

type EramParsed = Readonly<{ _tag: 'Parsed'; command: AtcCommand }> | Readonly<{ _tag: 'Display'; display: DisplayCommand }> | Readonly<{ error: string }>

/** `<1-9>`, `/<0-3>` or `<1-9>/<0-3>`: a data block position and/or leader length. */
const parseBlockPosition = (token: string): DisplayCommand | null => {
  const m = /^([1-9])?(?:\/([0-3]))?$/.exec(token)
  if (m === null || (m[1] === undefined && m[2] === undefined) || token === '') {
    return null
  }
  return DisplayCommand.PositionBlock({ position: m[1] === undefined ? null : parseInt(m[1], 10), leader: m[2] === undefined ? null : parseInt(m[2], 10) })
}

/** An ERAM verb with its arguments (the flight id already taken off the end). */
const parseEramVerb = (world: World, verb: string, args: ReadonlyArray<string>, hasFlid: boolean): EramParsed => {
  switch (verb) {
    case 'QZ': {
      const altitude = parseEramAltitude(args[0])
      return altitude === null ? { error: 'QZ <altitude> <FLID>' } : { _tag: 'Parsed', command: AtcCommand.AssignAltitude({ altitude }) }
    }
    case 'QQ': {
      if (args.length === 0 || args[0] === 'L') {
        return { _tag: 'Parsed', command: AtcCommand.InterimAltitude({ altitude: null }) }
      }
      const altitude = parseEramAltitude(args[0]!.replace(/^[RLP]/, ''))
      return altitude === null ? { error: 'QQ <altitude> <FLID>' } : { _tag: 'Parsed', command: AtcCommand.InterimAltitude({ altitude }) }
    }
    case 'QS': {
      const arg = args.join(' ')
      if (arg === '') {
        return { _tag: 'Display', display: DisplayCommand.ToggleHsf() }
      }
      if (arg === '*') {
        return { _tag: 'Parsed', command: AtcCommand.SetHsf({ heading: null, speed: null, text: null, clear: 'all' }) }
      }
      if (arg === '*/') {
        return { _tag: 'Parsed', command: AtcCommand.SetHsf({ heading: null, speed: null, text: null, clear: 'heading' }) }
      }
      if (arg === '/*') {
        return { _tag: 'Parsed', command: AtcCommand.SetHsf({ heading: null, speed: null, text: null, clear: 'speed' }) }
      }
      const speed = /^\/(\d{2,3})$/.exec(arg)
      if (speed !== null) {
        return { _tag: 'Parsed', command: AtcCommand.SetHsf({ heading: null, speed: parseInt(speed[1]!, 10), text: null, clear: 'none' }) }
      }
      const heading = /^(\d{3})$/.exec(arg)
      if (heading !== null) {
        return { _tag: 'Parsed', command: AtcCommand.SetHsf({ heading: parseInt(heading[1]!, 10) % 360, speed: null, text: null, clear: 'none' }) }
      }
      return { _tag: 'Parsed', command: AtcCommand.SetHsf({ heading: null, speed: null, text: arg.replace(/^[`ⵔ]\s*/, ''), clear: 'none' }) }
    }
    case 'QU': {
      if (args.length === 0) {
        return hasFlid ? { _tag: 'Display', display: DisplayCommand.RouteDisplay({ minutes: null }) } : { _tag: 'Display', display: DisplayCommand.ClearRoutes() }
      }
      const first = args[0]!
      if (first === '/M') {
        return { _tag: 'Display', display: DisplayCommand.RouteDisplay({ minutes: 999 }) }
      }
      if (/^\d{1,3}$/.test(first)) {
        return { _tag: 'Display', display: DisplayCommand.RouteDisplay({ minutes: parseInt(first, 10) }) }
      }
      const fix = first.replace(/^\/OK$/, '') === '' ? args[1] : first
      return fix === undefined ? { error: 'QU <fix> <FLID>' } : { _tag: 'Parsed', command: AtcCommand.AmendDirect({ fix }) }
    }
    case 'QT':
      return { _tag: 'Parsed', command: AtcCommand.Track() }
    case 'QX':
      return { _tag: 'Parsed', command: AtcCommand.Drop() }
    case 'QF':
      return { _tag: 'Parsed', command: AtcCommand.FlightPlanReadout() }
    case 'QB': {
      const code = args[0]
      if (code === undefined) {
        return { _tag: 'Parsed', command: AtcCommand.RequestBeacon() }
      }
      return /^[0-7]{4}$/.test(code) ? { _tag: 'Parsed', command: AtcCommand.Squawk({ code }) } : { error: 'QB <code> <FLID>' }
    }
    case 'QP':
      return args[0] === 'J' || args[0] === 'T' ? { _tag: 'Display', display: DisplayCommand.ToggleHalo() } : { error: 'QP J <FLID> toggles the halo' }
    case 'AM': {
      // AM <FLID> <field> <value>: the FLID was taken from the front by the caller
      const field = args[0]
      const value = args[1]
      if (field === 'ALT' || field === '8') {
        const altitude = parseEramAltitude(value)
        return altitude === null ? { error: 'AM <FLID> ALT <altitude>' } : { _tag: 'Parsed', command: AtcCommand.AssignAltitude({ altitude }) }
      }
      if (field === 'BCN' || field === '4') {
        return value !== undefined && /^[0-7]{4}$/.test(value) ? { _tag: 'Parsed', command: AtcCommand.Squawk({ code: value }) } : { error: 'AM <FLID> BCN <code>' }
      }
      return field === undefined ? { _tag: 'Parsed', command: AtcCommand.FlightPlanReadout() } : { error: `AM ${field} is not supported (ALT, BCN)` }
    }
    case 'MR':
      return { _tag: 'Display', display: DisplayCommand.GeoMap({ name: args[0] ?? null }) }
    default:
      return world.airport.sectors.some((p) => p.sector === verb) ? { _tag: 'Parsed', command: AtcCommand.HandoffSector({ sector: verb }) } : { error: `unknown ERAM command ${verb}` }
  }
}

/**
 * An ERAM message (Phase 9): `QZ 350 DAL123`, `QU MUSCL DAL123`, `06 DAL123`
 * (a sector handoff), `//DAL123`, `3/2 DAL123`, `QU` alone. The flight id is the
 * last token; without one, the selected aircraft is used. Null when the line is
 * not an ERAM message.
 */
export const parseEramLine = (world: World, selected: string | null, tokens: ReadonlyArray<string>): ParseResult | null => {
  const upper = tokens.map((t) => t.toUpperCase())
  const first = upper[0] ?? ''
  const vci = /^\/\/(.*)$/.exec(first)
  const inlineFlid = vci?.[1] ?? ''
  const isSector = world.airport.sectors.some((p) => p.sector === first)
  const isEram = isEramVerb(first) || vci !== null || parseBlockPosition(first) !== null || isSector
  if (!isEram) {
    return null
  }
  // AM <FLID> ...: the flight id comes second, as ERAM has it
  if (first === 'AM') {
    const flid = upper[1] === undefined ? null : matchCallsign(world, upper[1])
    const callsign = flid?.callsign ?? selected
    const out = parseEramVerb(world, 'AM', upper.slice(flid === null ? 1 : 2), true)
    return 'error' in out ? { _tag: 'Invalid', callsign, error: out.error } : out._tag === 'Parsed' ? { _tag: 'Parsed', callsign, command: out.command } : { _tag: 'Display', callsign, display: out.display }
  }
  if (first === 'MR') {
    return { _tag: 'Display', callsign: null, display: DisplayCommand.GeoMap({ name: upper[1] ?? null }) }
  }
  const last = upper[upper.length - 1]
  const flid = last !== undefined && upper.length > (inlineFlid !== '' ? 0 : 1) ? matchCallsign(world, last) : null
  const inline = inlineFlid !== '' ? matchCallsign(world, inlineFlid) : null
  const callsign = inline?.callsign ?? flid?.callsign ?? selected
  const hasFlid = inline !== null || flid !== null
  const args = upper.slice(1, flid !== null ? -1 : undefined)
  if (vci !== null) {
    return callsign === null ? { _tag: 'Invalid', callsign: null, error: '//<FLID>' } : { _tag: 'Display', callsign, display: DisplayCommand.ToggleVci() }
  }
  const position = parseBlockPosition(first)
  if (position !== null) {
    return callsign === null ? { _tag: 'Invalid', callsign: null, error: `${first} <FLID>` } : { _tag: 'Display', callsign, display: position }
  }
  const out = parseEramVerb(world, first, args, hasFlid)
  if ('error' in out) {
    return { _tag: 'Invalid', callsign, error: out.error }
  }
  if (out._tag === 'Display') {
    return out.display._tag === 'ClearRoutes' || out.display._tag === 'GeoMap' ? { _tag: 'Display', callsign: null, display: out.display } : callsign === null ? { _tag: 'Invalid', callsign: null, error: `${first} needs a flight id` } : { _tag: 'Display', callsign, display: out.display }
  }
  return callsign === null ? { _tag: 'Invalid', callsign: null, error: `${first} needs a flight id` } : { _tag: 'Parsed', callsign, command: out.command }
}

/**
 * A leading callsign (exact, or unique prefix/suffix) selects the aircraft; the
 * selected aircraft is used otherwise. Text that is not a command is `Unknown` so
 * the app can hand it to the AI translator. ERAM messages (verb first, flight id
 * last) are recognised too, and a bare flight id toggles its data block.
 */
export const parseCommandLine = (world: World, selected: string | null, text: string): ParseResult => {
  const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) {
    return { _tag: 'Empty' }
  }
  const eram = parseEramLine(world, selected, tokens)
  if (eram !== null) {
    return eram
  }
  if (tokens.length === 1 && !isVerb(tokens[0]!)) {
    const only = matchCallsign(world, tokens[0]!)
    if (only !== null) {
      return { _tag: 'Display', callsign: only.callsign, display: DisplayCommand.ToggleBlock() }
    }
  }
  let callsign = selected
  let i = 0
  if (!isVerb(tokens[0]!)) {
    const match = matchCallsign(world, tokens[0]!)
    if (match !== null) {
      callsign = match.callsign
      i = 1
    }
  }
  const verb = (tokens[i] ?? '').toUpperCase()
  if (!VERBS.has(verb)) {
    return { _tag: 'Unknown' }
  }
  const parsed = parseVerb(verb, tokens.slice(i + 1))
  if ('error' in parsed) {
    return { _tag: 'Invalid', callsign, error: parsed.error }
  }
  return { _tag: 'Parsed', callsign, command: parsed }
}

// EXECUTOR

export type ExecResult = WorldResult | Readonly<{ error: string }>

type Outcome = Readonly<{ aircraft: Aircraft; events: ReadonlyArray<SimEvent> }> | Readonly<{ error: string }>

const said = (a: Aircraft, p: Phrase): SimEvent => SimEvent.PilotSaid({ callsign: a.callsign, phrase: p })
const reply = (aircraft: Aircraft, p: Phrase, before: ReadonlyArray<SimEvent> = []): Outcome => ({
  aircraft,
  events: [...before, said(aircraft, p)],
})
const fail = (error: string): Outcome => ({ error })

/** A runway designator or full name to the full name, or null when unknown. */
const runwayNamed = (graph: Graph, token: string): string | null =>
  graph.runwayEnds[token]?.runway ?? (isRunwayName(graph, token) ? token : null)

type TaxiTokens =
  | Readonly<{ names: ReadonlyArray<string>; gate: string | null; runways: ReadonlyArray<string> }>
  | Readonly<{ error: string }>

/** Taxiways route the aircraft; a gate or spot ends the route; a runway named as a taxiway is cleared for the taxi. */
const resolveTaxiTokens = (graph: Graph, tokens: ReadonlyArray<string>): TaxiTokens => {
  const names: Array<string> = []
  const runways: Array<string> = []
  let gate: string | null = null
  for (const t of tokens) {
    const runway = runwayNamed(graph, t)
    if (graph.taxiways[t] !== undefined) {
      names.push(t)
    } else if (graph.parking[t] !== undefined) {
      gate = t
    } else if (runway !== null) {
      names.push(runway)
      runways.push(runway)
    } else {
      return { error: `unfamiliar with ${t}` }
    }
  }
  return { names, gate, runways }
}

/** The runways of a CROSS clause as full names, in the order given. */
const resolveCrossings = (graph: Graph, tokens: ReadonlyArray<string>): ReadonlyArray<string> | Readonly<{ error: string }> => {
  const runways: Array<string> = []
  for (const t of tokens) {
    const runway = runwayNamed(graph, t)
    if (runway === null) {
      return { error: `no runway ${t}` }
    }
    if (!runways.includes(runway)) {
      runways.push(runway)
    }
  }
  return runways
}

/** Where a taxi starts: the gate's node when parked, else the nearest node. */
const taxiStart = (graph: Graph, a: Aircraft): number => {
  const home = a.gate !== null ? graph.parking[a.gate] : undefined
  return a.state === 'PARKED' && home !== undefined ? home.node : nearestNode(graph, a.position)
}

/** Position the hold nearest to: the gate when parked, else where the aircraft is. */
const taxiOrigin = (graph: Graph, a: Aircraft): LonLat => graph.nodes[taxiStart(graph, a)]!

const beginTaxi = (
  world: World,
  a: Aircraft,
  names: ReadonlyArray<string>,
  gate: string | null,
  runway: string | null,
  intersection: string | null,
  cleared: ReadonlyArray<string>,
): Aircraft | Readonly<{ error: string }> => {
  const graph = world.graph
  const home = a.gate !== null ? graph.parking[a.gate] : undefined
  const from = taxiStart(graph, a)
  let finalNode: number | null = null
  if (gate !== null) {
    finalNode = graph.parking[gate]?.node ?? null
  } else if (runway !== null) {
    const hold = departureHold(graph, runway, intersection, taxiOrigin(graph, a))
    if ('error' in hold) {
      return hold
    }
    finalNode = hold.hold
  }
  const route = routeVia(graph, from, names, finalNode, cleared)
  if ('error' in route) {
    return route
  }
  const start: Aircraft = a.state === 'PARKED' && home !== undefined ? { ...a, position: home.c } : a
  return {
    ...withPath(graph, { ...start, cleared }, route.path),
    destinationGate: gate,
    runway,
    intersection: runway === null ? null : intersection,
    state: 'TAXI',
    giveWayTo: null,
  }
}

/** "runway 30L" or "runway 30L at D": how a departure names where it will enter. */
const runwayWords = (runway: string, intersection: string | null): ReadonlyArray<PhrasePart> =>
  intersection === null ? ['runway', runwayToken(runway)] : ['runway', runwayToken(runway), 'at', taxiways([intersection])]

/** ", cross runway 12R" for each runway of the CROSS clause, as the controller named them. */
const crossingWords = (tokens: ReadonlyArray<string>): ReadonlyArray<PhrasePart> =>
  tokens.flatMap((t) => [', cross runway', runwayToken(t)])

/**
 * The route as the pilot reads it back: runs of one name, short runs flanked by
 * the same name absorbed, tiny runs dropped, consecutive taxiways grouped so the
 * voice pauses between them.
 */
export const routeSummary = (graph: Graph, a: Aircraft): ReadonlyArray<PhraseToken> => {
  if (a.path === null) {
    return []
  }
  const runs: Array<[string, number]> = []
  for (let i = 0; i + 1 < a.path.length; i++) {
    const name = edgeName(graph, a.path[i]!, a.path[i + 1]!)
    if (name === null) {
      continue
    }
    const d = distanceFt(graph.projection, graph.nodes[a.path[i]!]!, graph.nodes[a.path[i + 1]!]!)
    const last = runs[runs.length - 1]
    if (last === undefined || last[0] !== name) {
      runs.push([name, d])
    } else {
      last[1] += d
    }
  }
  for (let i = 1; i < runs.length - 1; i++) {
    if (runs[i - 1]![0] === runs[i + 1]![0] && runs[i]![1] < 1400) {
      runs[i - 1]![1] += runs[i]![1] + runs[i + 1]![1]
      runs.splice(i, 2)
      i--
    }
  }
  const names: Array<string> = []
  for (const [name, d] of runs) {
    if (d < 300 && names.length > 0 && runs.length > 2) {
      continue
    }
    if (names[names.length - 1] !== name) {
      names.push(name)
    }
  }
  const tokens: Array<PhraseToken> = []
  for (const name of names) {
    const last = tokens[tokens.length - 1]
    if (isRunwayName(graph, name)) {
      tokens.push(runwayToken(name))
    } else if (last !== undefined && last._tag === 'Taxiways') {
      tokens[tokens.length - 1] = taxiways([...last.names, name])
    } else {
      tokens.push(taxiways([name]))
    }
  }
  return tokens
}

const holdShort = (graph: Graph, a: Aircraft, point: string): Outcome => {
  if (a.path === null) {
    return fail('hold short of what?')
  }
  const runway = runwayNamed(graph, point)
  for (let i = a.leg; i + 1 < a.path.length; i++) {
    const name = edgeName(graph, a.path[i]!, a.path[i + 1]!)
    const enters = runway !== null && runwaysEntered(graph, a.path[i]!, a.path[i + 1]!).includes(runway)
    if (enters || name === point || (runway !== null && name === runway)) {
      const held = armHold(graph, { ...a, holdShortLeg: i }, a.leg)
      return reply(held, phrase('hold short of', runway !== null ? runwayToken(point) : taxiways([point])))
    }
  }
  return fail(`${point} is not on the route`)
}

/**
 * Clear the aircraft across a runway: the one named, else the one it is holding
 * short of (or would next hold short of), else its departure runway. A hold-short
 * point at that same crossing is released with it; the next stop is re-armed and
 * the aircraft moves again only if nothing holds it where it is.
 */
const cross = (graph: Graph, a: Aircraft, named: string | null): Outcome => {
  const target = holdTarget(graph, a)
  let name: string | null
  if (named !== null) {
    name = runwayNamed(graph, named)
    if (name === null) {
      return fail(`no runway ${named}`)
    }
  } else {
    name = target ?? (a.runway !== null ? runwayNamed(graph, a.runway) : null)
    if (name === null) {
      return fail('not holding short of anything')
    }
  }
  const cleared = isRunwayName(graph, name) && !a.cleared.includes(name) ? [...a.cleared, name] : a.cleared
  const releasesHoldShort = a.holdShortLeg !== null && a.holdShortLeg === a.holdLeg && target === name
  const armed = armHold(graph, { ...a, cleared, holdShortLeg: releasesHoldShort ? null : a.holdShortLeg }, a.leg)
  const stillHeld = armed.holdLeg !== null && armed.leg >= armed.holdLeg
  const next: Aircraft = { ...armed, state: armed.state === 'SHORT' && !stillHeld ? 'TAXI' : armed.state }
  const token = named !== null || isRunwayName(graph, name) ? runwayToken(named ?? name) : taxiways([name])
  return reply(next, phrase('crossing', token))
}

/** The runway node a departure enters from its hold: full length, or the intersection named. */
const runwayEntry = (graph: Graph, a: Aircraft, intersection: string | null): Readonly<{ node: number }> | Readonly<{ error: string }> => {
  const hold = departureHold(graph, a.runway ?? '', intersection, a.position)
  return 'error' in hold ? hold : { node: hold.entry }
}

/** Stopped at (or about to stop at) the armed hold point, with route still ahead. */
const heldAtStop = (a: Aircraft): boolean =>
  a.holdLeg !== null && a.path !== null && a.leg >= a.holdLeg && a.leg < a.path.length - 1

const withTaxiReadback = (
  world: World,
  taxied: Aircraft,
  holdShortPoint: string | null,
  readback: (summary: ReadonlyArray<PhraseToken>) => Phrase,
): Outcome => {
  const hs = holdShortPoint !== null ? holdShort(world.graph, taxied, holdShortPoint) : null
  if (hs !== null && 'error' in hs) {
    return hs
  }
  const after = hs !== null ? hs.aircraft : taxied
  return reply(after, readback(routeSummary(world.graph, after)), hs !== null ? hs.events : [])
}

const executeFor = (world: World, a: Aircraft, command: AtcCommand): Outcome => {
  const graph = world.graph
  return AtcCommand.match(command, {
    Push: ({ taxiway }) => {
      if (a.state !== 'PARKED') {
        return fail('not at a gate')
      }
      const spot = a.gate !== null ? graph.parking[a.gate] : undefined
      if (spot === undefined) {
        return fail('gate unknown')
      }
      let target = spot.node
      if (taxiway !== null) {
        const n = nearestOn(graph, taxiway, spot.node)
        if (n !== null) {
          target = n
        }
      }
      const found = target === spot.node ? null : findPath(graph, spot.node, target, { runwayPenalty: PUSHBACK_RUNWAY_PENALTY_FT })
      const nodes = found !== null && found.length > 1 ? found : [spot.node, spot.node]
      const next: Aircraft = {
        ...a,
        position: spot.c,
        heading: spot.heading,
        origin: spot.c,
        path: nodes,
        leg: 0,
        frac: 0,
        holdLeg: null,
        state: 'PUSH',
      }
      return reply(next, phrase('pushing back off', gateToken(a.gate ?? '')))
    },

    Taxi: ({ via, cross: crossing, holdShort: hs }) => {
      const tokens = resolveTaxiTokens(graph, via)
      if ('error' in tokens) {
        return fail(tokens.error)
      }
      const crossings = resolveCrossings(graph, crossing)
      if ('error' in crossings) {
        return fail(crossings.error)
      }
      // TAXI continues to what the aircraft was already given: a named gate, the
      // assigned runway's hold point, or an arrival's gate. It never assigns a runway.
      const gate = tokens.gate ?? (a.runway === null ? a.destinationGate : null)
      if (gate === null && a.runway === null) {
        return fail('no runway assigned — use RWY')
      }
      const taxied = beginTaxi(world, a, tokens.names, gate, a.runway, a.intersection, [...tokens.runways, ...crossings])
      if ('error' in taxied) {
        return fail(taxied.error)
      }
      return withTaxiReadback(world, taxied, hs, (summary) =>
        summary.length > 0
          ? phrase('taxi via', ...summary, ...crossingWords(crossing))
          : phrase('taxi via the ramp', ...crossingWords(crossing)),
      )
    },

    Runway: ({ runway, at, via, cross: crossing, holdShort: hs }) => {
      if (graph.runwayEnds[runway] === undefined) {
        return fail(`no runway ${runway}`)
      }
      const tokens = resolveTaxiTokens(graph, via)
      if ('error' in tokens) {
        return fail(tokens.error)
      }
      const crossings = resolveCrossings(graph, crossing)
      if ('error' in crossings) {
        return fail(crossings.error)
      }
      const taxied = beginTaxi(world, a, tokens.names, null, runway, at, [...tokens.runways, ...crossings])
      if ('error' in taxied) {
        return fail(taxied.error)
      }
      return withTaxiReadback(world, taxied, hs, (summary) =>
        summary.length > 0
          ? phrase(...runwayWords(runway, at), ', taxi via', ...summary, ...crossingWords(crossing))
          : phrase(...runwayWords(runway, at), ', taxi via the field', ...crossingWords(crossing)),
      )
    },

    HoldShort: ({ point }) => holdShort(graph, a, point),

    Cross: ({ runway }) => cross(graph, a, runway),

    Resume: () => {
      if (heldAtStop(a)) {
        return cross(graph, a, null)
      }
      if (a.state === 'HOLD' || a.state === 'PUSHED' || a.state === 'SHORT') {
        if (a.path === null || a.leg >= a.path.length - 1) {
          return fail('no route to resume — give a taxi instruction')
        }
        return reply({ ...a, state: 'TAXI', giveWayTo: null }, phrase('continuing'))
      }
      return fail('already moving')
    },

    Hold: () => reply({ ...a, state: 'HOLD' }, phrase('holding')),

    Break: () =>
      reply(
        { ...a, breakUntil: world.simTime + 15, giveWayTo: null, state: a.state === 'HOLD' ? 'TAXI' : a.state },
        phrase('coming through'),
      ),

    GiveWay: ({ callsign }) => {
      const other = matchCallsign(world, callsign)
      if (other === null) {
        return fail(`no aircraft ${callsign}`)
      }
      return reply({ ...a, giveWayTo: other.callsign }, phrase('giving way to', callsignToken(other.callsign)))
    },

    LineUpAndWait: ({ at }) => {
      const end = a.runway !== null ? graph.runwayEnds[a.runway] : undefined
      if (end === undefined || a.runway === null) {
        return fail('no departure runway assigned — use RWY first')
      }
      const intersection = at ?? a.intersection
      const entry = runwayEntry(graph, a, intersection)
      if ('error' in entry) {
        return fail(entry.error)
      }
      const cleared = a.cleared.includes(end.runway) ? a.cleared : [...a.cleared, end.runway]
      const route = findPath(graph, nearestNode(graph, a.position), entry.node, { runwayPenalty: 0 })
      if (route === null) {
        return fail('cannot reach the runway')
      }
      return reply(
        { ...withPath(graph, { ...a, cleared }, route), intersection, state: 'TAXI', lineUpAfterTaxi: true },
        intersection === null ? phrase('line up and wait') : phrase(...runwayWords(a.runway, intersection), ', line up and wait'),
      )
    },

    ClearedForTakeoff: ({ heading, turn, at }) => {
      const end = a.runway !== null ? graph.runwayEnds[a.runway] : undefined
      if (end === undefined || a.runway === null) {
        return fail('no departure runway assigned')
      }
      const intersection = at ?? a.intersection
      const entry = runwayEntry(graph, a, intersection)
      if ('error' in entry) {
        return fail(entry.error)
      }
      const cleared = a.cleared.includes(end.runway) ? a.cleared : [...a.cleared, end.runway]
      const near = nearestNode(graph, a.position)
      const onRunway = end.chain.includes(near)
      const startNode = onRunway ? near : entry.node
      const chain = end.chain.slice(end.chain.indexOf(startNode))
      let nodes: ReadonlyArray<number>
      if (onRunway) {
        nodes = chain
      } else {
        const route = findPath(graph, near, entry.node, { runwayPenalty: 0 })
        if (route === null) {
          return fail('cannot reach the runway')
        }
        nodes = [...route, ...chain.slice(1)]
      }
      const rolling: Aircraft = {
        ...withPath(graph, { ...a, cleared }, nodes),
        intersection,
        holdLeg: null,
        state: 'TKOF',
        lineUpAfterTaxi: false,
        departureHeading: heading,
        departureTurn: heading === null ? null : turn,
      }
      if (heading === null) {
        return reply(
          rolling,
          intersection === null
            ? phrase('cleared for takeoff runway', runwayToken(a.runway))
            : phrase(...runwayWords(a.runway, intersection), ', cleared for takeoff'),
        )
      }
      const lead = turn === 'L' ? 'turn left heading' : turn === 'R' ? 'turn right heading' : 'fly heading'
      return reply(rolling, phrase(lead, digits(String(heading).padStart(3, '0')), ',', ...runwayWords(a.runway, intersection), ', cleared for takeoff'))
    },

    Exit: () => {
      if (a.state !== 'ROLLOUT' && a.state !== 'HOLD') {
        return fail('not on a landing roll')
      }
      const out = autoExit(world, a)
      return out.aircraft === null ? fail('cannot exit') : { aircraft: out.aircraft, events: out.events }
    },

    GoAround: () => {
      if (a.state !== 'FINAL' || a.landed) {
        return fail('not on final')
      }
      const out = goAround(world, a, null)
      return out.aircraft === null ? fail('cannot go around') : { aircraft: out.aircraft, events: out.events }
    },

    ClearedToLand: () => {
      if (a.state !== 'FINAL' || a.landed) {
        return fail('not on final')
      }
      return reply({ ...a, clearedToLand: true }, phrase('cleared to land runway', runwayToken(a.runway ?? '')))
    },

    Track: () => {
      if (a.radar === null) {
        return fail('no radar target')
      }
      return { aircraft: { ...a, tracked: true }, events: [SimEvent.SystemNote({ text: `${a.callsign} tracked` })] }
    },

    Drop: () => ({ aircraft: { ...a, tracked: false }, events: [SimEvent.SystemNote({ text: `${a.callsign} track dropped` })] }),

    ContactDeparture: () => {
      if (a.state !== 'AIRB' && a.state !== 'TKOF') {
        return fail('not airborne')
      }
      if (a.handoff) {
        return fail('already switched')
      }
      const d = nextFacility(world, a.handoffSector)
      const fallback = world.rules.handoffTo === 'center' ? 'contact center' : 'contact departure'
      const readback =
        d === null ? phrase(fallback) : d.freq !== null ? phrase(`over to ${d.radio}`, frequency(d.freq)) : phrase(`over to ${d.radio}`)
      return reply({ ...a, handoff: true, handoffAt: world.simTime, handoffTo: world.rules.handoffTo }, readback)
    },

    ContactTower: () => {
      if (a.state !== 'AIRB' && a.state !== 'FINAL') {
        return fail('not airborne')
      }
      if (a.handoff) {
        return fail('already switched')
      }
      const freq = world.airport.towerFreq
      const readback = freq !== null ? phrase(`over to ${towerRadioName(world)}`, frequency(freq)) : phrase(`over to ${towerRadioName(world)}`)
      return reply({ ...a, handoff: true, handoffAt: world.simTime, handoffTo: 'tower' }, readback)
    },

    ContactApproach: () => {
      if (a.state !== 'AIRB') {
        return fail('not airborne')
      }
      if (a.handoff) {
        return fail('already switched')
      }
      const app = world.airport.approach
      const name = app?.radio ?? approachRadioName(world)
      const readback = app?.freq ? phrase(`over to ${name}`, frequency(app.freq)) : phrase(`over to ${name}`)
      return reply({ ...a, handoff: true, handoffAt: world.simTime, handoffTo: 'approach' }, readback)
    },

    AssignAltitude: ({ altitude }) => ({ aircraft: { ...a, assignedAltitude: altitude, interimAltitude: null }, events: [] }),

    InterimAltitude: ({ altitude }) => ({ aircraft: { ...a, interimAltitude: altitude }, events: [] }),

    SetHsf: ({ heading, speed, text, clear }) => {
      const hsf =
        clear === 'all'
          ? { heading: null, speed: null, text: null }
          : clear === 'heading'
            ? { ...a.hsf, heading: null }
            : clear === 'speed'
              ? { ...a.hsf, speed: null }
              : { heading: heading ?? a.hsf.heading, speed: speed ?? a.hsf.speed, text: text ?? a.hsf.text }
      return { aircraft: { ...a, hsf }, events: [] }
    },

    AmendDirect: ({ fix }) => {
      if (world.nav.fixes[fix] === undefined) {
        return fail(`unfamiliar with ${fix}`)
      }
      const tokens = (a.flightPlan.route ?? '').split(/\s+/).filter((t) => t !== '')
      const at = tokens.indexOf(fix)
      const route = [fix, ...(at >= 0 ? tokens.slice(at + 1) : tokens.filter((t) => t !== fix))].join(' ')
      return { aircraft: { ...a, flightPlan: { ...a.flightPlan, route } }, events: [SimEvent.SystemNote({ text: `${a.callsign} route amended: ${route}` })] }
    },

    FlightPlanReadout: () => ({ aircraft: a, events: [SimEvent.SystemNote({ text: flightPlanReadout(world, a) })] }),

    RequestBeacon: () => {
      const [n] = nextInt(world.prng, 6000)
      const code = String(1000 + n)
      return reply({ ...a, squawk: code, transponder: 'N' }, phrase('squawking', digits(code)))
    },

    HandoffSector: ({ sector }) => {
      if (!a.tracked) {
        return fail('not tracked')
      }
      if (a.handoffSector !== null) {
        return fail(`handoff to ${a.handoffSector} already started`)
      }
      return { aircraft: { ...a, handoffSector: sector, handoffSectorAt: world.simTime }, events: [SimEvent.SystemNote({ text: `${a.callsign} handoff to sector ${sector}` })] }
    },

    RecallHandoff: () => {
      if (a.handoffSector === null) {
        return fail('no handoff pending')
      }
      if (handoffAccepted(a, world.simTime)) {
        return fail(`sector ${a.handoffSector} has the handoff`)
      }
      return { aircraft: { ...a, handoffSector: null }, events: [SimEvent.SystemNote({ text: `${a.callsign} handoff recalled` })] }
    },

    FlyHeading: ({ heading, turn }) => {
      if (a.state !== 'AIRB') {
        return fail('not airborne')
      }
      const lead = turn === 'L' ? 'turn left heading' : turn === 'R' ? 'turn right heading' : 'heading'
      return reply(
        { ...a, targetHeading: heading % 360, turn, fixes: [], approach: null, established: false, departureHeading: null, departureTurn: null },
        phrase(lead, digits(String(heading).padStart(3, '0'))),
      )
    },

    Direct: ({ fix }) => {
      if (a.state !== 'AIRB') {
        return fail('not airborne')
      }
      if (world.nav.fixes[fix] === undefined) {
        return fail(`unfamiliar with ${fix}`)
      }
      const at = a.fixes.indexOf(fix)
      const fixes = at >= 0 ? a.fixes.slice(at) : [fix]
      return reply(
        { ...a, fixes, turn: null, approach: null, established: false, departureHeading: null, departureTurn: null },
        phrase('direct', fixToken(fix)),
      )
    },

    Speed: ({ knots }) => {
      if (a.state !== 'AIRB') {
        return fail('not airborne')
      }
      return knots === null
        ? reply({ ...a, assignedSpeed: null }, phrase('resume normal speed'))
        : reply({ ...a, assignedSpeed: knots }, phrase(knots < a.speed ? 'reduce speed to' : 'increase speed to', digits(String(knots))))
    },

    ExpectRunway: ({ runway }) => {
      if (graph.runwayEnds[runway] === undefined) {
        return fail(`no runway ${runway}`)
      }
      return reply({ ...a, runway, intersection: null }, phrase('expect runway', runwayToken(runway)))
    },

    ClearedApproach: ({ runway: named }) => {
      if (a.state !== 'AIRB') {
        return fail('not airborne')
      }
      const runway = named ?? a.runway
      if (runway === null) {
        return fail('which runway?')
      }
      if (graph.runwayEnds[runway] === undefined) {
        return fail(`no runway ${runway}`)
      }
      return reply({ ...a, runway, approach: runway, established: false }, phrase('cleared ILS runway', runwayToken(runway), 'approach'))
    },

    ClimbMaintain: ({ altitude }) => {
      if (a.state !== 'AIRB') {
        return fail('not airborne')
      }
      return reply(
        { ...a, targetAltitude: altitude },
        phrase(`${altitude > a.altitude ? 'climb' : 'descend'} and maintain ${altitudeWords(altitude)}`),
      )
    },

    Squawk: ({ code }) => reply({ ...a, squawk: code, transponder: 'N' }, phrase('squawking', digits(code))),
    SquawkNormal: () => reply({ ...a, transponder: 'N' }, phrase('squawking normal')),
    SquawkStandby: () => reply({ ...a, transponder: 'S' }, phrase('squawk standby')),
    Ident: () => reply({ ...a, transponder: 'I', identUntil: world.simTime + 4 }, phrase('ident')),

    Say: ({ what }) => {
      if (what === 'GATE') {
        return reply(a, a.gate !== null ? phrase("we're at", gateToken(a.gate)) : phrase("we're not at a gate"))
      }
      if (what === 'TYPE') {
        return reply(a, phrase(`we're a ${a.type}`))
      }
      if (what === 'RWY' || what === 'RUNWAY') {
        return reply(a, a.runway !== null ? phrase('expecting', ...runwayWords(a.runway, a.intersection)) : phrase('no runway assigned'))
      }
      return reply(
        a,
        phrase(
          `${a.type} at`,
          ...(a.gate !== null ? [gateToken(a.gate)] : ['the ramp']),
          `, ${a.departure ?? world.airport.id} to ${a.destination ?? '—'}`,
        ),
      )
    },

    Delete: () => ({ aircraft: a, events: [SimEvent.SystemNote({ text: `${a.callsign} deleted` })] }),

    TaxiAll: () => fail('global'),
    Pause: () => fail('global'),
    Unpause: () => fail('global'),
    SimRate: () => fail('global'),
  })
}

/** The QF readout: time, CID, ACID(sector), type, beacon, filed speed, assigned altitude, route, destination. */
export const flightPlanReadout = (world: World, a: Aircraft): string => {
  const t = Math.floor(world.simTime)
  const time = `${String(Math.floor(t / 3600) % 24).padStart(2, '0')}${String(Math.floor(t / 60) % 60).padStart(2, '0')}`
  const altitude = a.assignedAltitude === null ? '' : String(Math.round(a.assignedAltitude / 100)).padStart(3, '0')
  const type = a.flightPlan.fullType ?? a.type
  const route = (a.flightPlan.route ?? '').split(/\s+/).filter((x) => x !== '').join('.')
  return `${time} ${a.cid} ${a.callsign}(${a.handoffSector ?? '--'}) ${type} ${a.squawk} ${a.flightPlan.cruiseSpeed ?? 0} ${altitude} ${a.departure ?? ''}.${route}.${a.destination ?? ''}`.replace(/\s+/g, ' ')
}

/** ERAM flight-plan entries: the pilot says nothing back, ERAM answers ACCEPT (or an error) in the MCA. */
export const isEramEntry = (c: AtcCommand): boolean =>
  c._tag === 'AssignAltitude' || c._tag === 'InterimAltitude' || c._tag === 'SetHsf' || c._tag === 'AmendDirect' || c._tag === 'FlightPlanReadout' || c._tag === 'HandoffSector' || c._tag === 'RecallHandoff' || c._tag === 'Track' || c._tag === 'Drop'

const executeGlobal = (world: World, command: AtcCommand): ExecResult =>
  AtcCommand.match<ExecResult>(command, {
    Pause: () => ({ world, events: [SimEvent.SetRunning({ running: false })] }),
    Unpause: () => ({ world, events: [SimEvent.SetRunning({ running: true })] }),
    SimRate: ({ rate }) => ({ world, events: [SimEvent.SetRate({ rate })] }),
    TaxiAll: () => {
      let n = 0
      const aircraft = world.aircraft.map((a) => {
        if (a.state === 'HOLD' && a.path !== null && a.leg < a.path.length - 1) {
          n++
          return { ...a, state: 'TAXI' as const, giveWayTo: null }
        }
        return a
      })
      return { world: { ...world, aircraft }, events: [SimEvent.SystemNote({ text: `${n} aircraft resumed` })] }
    },
    Push: () => ({ error: 'select an aircraft first' }),
    Taxi: () => ({ error: 'select an aircraft first' }),
    Runway: () => ({ error: 'select an aircraft first' }),
    HoldShort: () => ({ error: 'select an aircraft first' }),
    Cross: () => ({ error: 'select an aircraft first' }),
    Resume: () => ({ error: 'select an aircraft first' }),
    Hold: () => ({ error: 'select an aircraft first' }),
    Break: () => ({ error: 'select an aircraft first' }),
    GiveWay: () => ({ error: 'select an aircraft first' }),
    LineUpAndWait: () => ({ error: 'select an aircraft first' }),
    ClearedForTakeoff: () => ({ error: 'select an aircraft first' }),
    Exit: () => ({ error: 'select an aircraft first' }),
    GoAround: () => ({ error: 'select an aircraft first' }),
    ClearedToLand: () => ({ error: 'select an aircraft first' }),
    Track: () => ({ error: 'select an aircraft first' }),
    Drop: () => ({ error: 'select an aircraft first' }),
    ContactDeparture: () => ({ error: 'select an aircraft first' }),
    FlyHeading: () => ({ error: 'select an aircraft first' }),
    ClimbMaintain: () => ({ error: 'select an aircraft first' }),
    Direct: () => ({ error: 'select an aircraft first' }),
    Speed: () => ({ error: 'select an aircraft first' }),
    ExpectRunway: () => ({ error: 'select an aircraft first' }),
    ClearedApproach: () => ({ error: 'select an aircraft first' }),
    ContactTower: () => ({ error: 'select an aircraft first' }),
    ContactApproach: () => ({ error: 'select an aircraft first' }),
    AssignAltitude: () => ({ error: 'select an aircraft first' }),
    InterimAltitude: () => ({ error: 'select an aircraft first' }),
    SetHsf: () => ({ error: 'select an aircraft first' }),
    AmendDirect: () => ({ error: 'select an aircraft first' }),
    FlightPlanReadout: () => ({ error: 'select an aircraft first' }),
    RequestBeacon: () => ({ error: 'select an aircraft first' }),
    HandoffSector: () => ({ error: 'select an aircraft first' }),
    RecallHandoff: () => ({ error: 'select an aircraft first' }),
    Squawk: () => ({ error: 'select an aircraft first' }),
    SquawkNormal: () => ({ error: 'select an aircraft first' }),
    SquawkStandby: () => ({ error: 'select an aircraft first' }),
    Ident: () => ({ error: 'select an aircraft first' }),
    Say: () => ({ error: 'select an aircraft first' }),
    Delete: () => ({ error: 'select an aircraft first' }),
  })

/** Apply a command to the World; `callsign` is the addressed aircraft, null for global commands. */
export const executeCommand = (world: World, callsign: string | null, command: AtcCommand): ExecResult => {
  if (isGlobalCommand(command) || callsign === null) {
    return executeGlobal(world, command)
  }
  const a = findAircraft(world, callsign)
  if (a === undefined) {
    return { error: `no aircraft ${callsign}` }
  }
  if (a.delay > 0) {
    return { error: `not on frequency yet (spawns in ${Math.ceil(a.delay)}s)` }
  }
  const out = executeFor(world, a, command)
  if ('error' in out) {
    return out
  }
  const drawn = command._tag === 'RequestBeacon' ? { ...world, prng: nextInt(world.prng, 6000)[1] } : world
  const next = command._tag === 'Delete' ? removeAircraft(drawn, callsign) : replaceAircraft(drawn, out.aircraft)
  return { world: next, events: out.events }
}
