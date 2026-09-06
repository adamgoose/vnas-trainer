/**
 * Controller commands (docs/REWRITE.md section 5, "Commands"): the command union,
 * the line parser and the executor. Executing a command is a pure function of the
 * World; the pilot's readback comes back as a SimEvent.
 */
import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import type { Aircraft } from './aircraft'
import { distanceFt } from './geo'
import { type Graph, edgeName, holdNodeFor, isRunwayName, nearestNode, nearestOn } from './graph'
import {
  type Phrase,
  type PhraseToken,
  altitudeWords,
  callsign as callsignToken,
  digits,
  frequency,
  gate as gateToken,
  phrase,
  runway as runwayToken,
  taxiways,
} from './phrase'
import { autoExit, firstRunwayLeg, goAround, legRunway, withPath } from './physics'
import { PUSHBACK_RUNWAY_PENALTY_FT, findPath, routeVia } from './route'
import { SimEvent, type World, type WorldResult, findAircraft, matchCallsign, removeAircraft, replaceAircraft } from './world'

// COMMAND

export const AtcCommand = defineTaggedUnion({
  Push: { taxiway: Schema.NullOr(Schema.String) },
  Taxi: { via: Schema.Array(Schema.String), holdShort: Schema.NullOr(Schema.String) },
  Runway: { runway: Schema.String, via: Schema.Array(Schema.String), holdShort: Schema.NullOr(Schema.String) },
  HoldShort: { point: Schema.String },
  Cross: { runway: Schema.NullOr(Schema.String) },
  Resume: {},
  Hold: {},
  Break: {},
  GiveWay: { callsign: Schema.String },
  TaxiAll: {},
  LineUpAndWait: {},
  ClearedForTakeoff: {},
  Exit: {},
  GoAround: {},
  ClearedToLand: {},
  Track: {},
  Drop: {},
  ContactDeparture: {},
  FlyHeading: { heading: Schema.Number, turn: Schema.NullOr(Schema.Literals(['L', 'R'])) },
  ClimbMaintain: { altitude: Schema.Number },
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

export type ParseResult =
  | Readonly<{ _tag: 'Parsed'; callsign: string | null; command: AtcCommand }>
  | Readonly<{ _tag: 'Invalid'; callsign: string | null; error: string }>
  | Readonly<{ _tag: 'Unknown' }>
  | Readonly<{ _tag: 'Empty' }>

const VERBS = new Set([
  'PUSH', 'TAXI', 'RWY', 'HS', 'CROSS', 'RES', 'HOLD', 'BREAK', 'GIVEWAY', 'GW', 'TAXIALL', 'LUAW', 'CTO', 'EXIT', 'GA',
  'CTL', 'TRACK', 'IC', 'DROP', 'DT', 'CD', 'FH', 'TL', 'TR', 'CM', 'SQ', 'SN', 'SS', 'ID', 'SAY', 'DEL', 'PAUSE', 'UNPAUSE',
  'SIMRATE',
])

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

const splitHoldShort = (args: ReadonlyArray<string>): readonly [ReadonlyArray<string>, string | null] => {
  const at = args.findIndex((t) => t.toUpperCase() === 'HS')
  if (at < 0) {
    return [args, null]
  }
  return [args.slice(0, at), args[at + 1]?.toUpperCase() ?? null]
}

type Parsed = AtcCommand | Readonly<{ error: string }>

const parseVerb = (verb: string, args: ReadonlyArray<string>): Parsed => {
  const upper = args.map((a) => a.toUpperCase())
  switch (verb) {
    case 'PUSH':
      return AtcCommand.Push({ taxiway: upper[0] ?? null })
    case 'TAXI': {
      const [via, holdShort] = splitHoldShort(upper)
      return via.length === 0 ? { error: 'taxi where?' } : AtcCommand.Taxi({ via, holdShort })
    }
    case 'RWY': {
      const runway = upper[0]
      if (runway === undefined) {
        return { error: 'which runway?' }
      }
      const rest = upper[1] === 'TAXI' ? upper.slice(2) : upper.slice(1)
      const [via, holdShort] = splitHoldShort(rest)
      return AtcCommand.Runway({ runway, via, holdShort })
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
    case 'LUAW':
      return AtcCommand.LineUpAndWait()
    case 'CTO':
      return AtcCommand.ClearedForTakeoff()
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
    case 'CM': {
      const altitude = parseAltitude(upper[0])
      return altitude === null ? { error: 'altitude?' } : AtcCommand.ClimbMaintain({ altitude })
    }
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

/**
 * A leading callsign (exact, or unique prefix/suffix) selects the aircraft; the
 * selected aircraft is used otherwise. Text that is not a command is `Unknown` so
 * the app can hand it to the AI translator.
 */
export const parseCommandLine = (world: World, selected: string | null, text: string): ParseResult => {
  const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) {
    return { _tag: 'Empty' }
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

type TaxiTokens = Readonly<{ names: ReadonlyArray<string>; gate: string | null }> | Readonly<{ error: string }>

const resolveTaxiTokens = (graph: Graph, tokens: ReadonlyArray<string>): TaxiTokens => {
  const names: Array<string> = []
  let gate: string | null = null
  for (const t of tokens) {
    if (graph.taxiways[t] !== undefined) {
      names.push(t)
    } else if (graph.parking[t] !== undefined) {
      gate = t
    } else if (graph.runwayEnds[t] !== undefined) {
      names.push(graph.runwayEnds[t]!.runway)
    } else {
      return { error: `unfamiliar with ${t}` }
    }
  }
  return { names, gate }
}

const beginTaxi = (
  world: World,
  a: Aircraft,
  names: ReadonlyArray<string>,
  gate: string | null,
  runway: string | null,
): Aircraft | Readonly<{ error: string }> => {
  const graph = world.graph
  const home = a.gate !== null ? graph.parking[a.gate] : undefined
  const from = a.state === 'PARKED' && home !== undefined ? home.node : nearestNode(graph, a.position)
  const finalNode = gate !== null ? (graph.parking[gate]?.node ?? null) : runway !== null ? holdNodeFor(graph, runway) : null
  const route = routeVia(graph, from, names, finalNode)
  if ('error' in route) {
    return route
  }
  const start: Aircraft = a.state === 'PARKED' && home !== undefined ? { ...a, position: home.c } : a
  return {
    ...withPath(graph, { ...start, cleared: [] }, route.path),
    destinationGate: gate,
    runway,
    state: 'TAXI',
    giveWayTo: null,
  }
}

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
  const runwayName = graph.runwayEnds[point]?.runway
  for (let i = a.leg; i + 1 < a.path.length; i++) {
    const name = edgeName(graph, a.path[i]!, a.path[i + 1]!)
    if (name === point || (runwayName !== undefined && name === runwayName)) {
      const isRunway = runwayName !== undefined || isRunwayName(graph, point)
      return reply({ ...a, holdLeg: i }, phrase('hold short of', isRunway ? runwayToken(point) : taxiways([point])))
    }
  }
  return fail(`${point} is not on the route`)
}

const cross = (graph: Graph, a: Aircraft, named: string | null): Outcome => {
  const name =
    a.holdLeg !== null && a.path !== null
      ? edgeName(graph, a.path[a.holdLeg]!, a.path[a.holdLeg + 1]!)
      : a.runway !== null
        ? (graph.runwayEnds[a.runway]?.runway ?? null)
        : null
  if (name === null) {
    return fail('not holding short of anything')
  }
  const cleared = a.cleared.includes(name) ? a.cleared : [...a.cleared, name]
  const next: Aircraft = { ...a, cleared, state: a.state === 'SHORT' ? 'TAXI' : a.state }
  return reply({ ...next, holdLeg: firstRunwayLeg(graph, next, next.leg) }, phrase('crossing', runwayToken(named ?? name)))
}

const withTaxiReadback = (
  world: World,
  taxied: Aircraft,
  holdShortPoint: string | null,
  readback: (summary: ReadonlyArray<PhraseToken>) => Phrase,
): Outcome => {
  const hs = holdShortPoint !== null ? holdShort(world.graph, taxied, holdShortPoint) : null
  const after = hs !== null && !('error' in hs) ? hs.aircraft : taxied
  const before = hs !== null && !('error' in hs) ? hs.events : []
  return reply(after, readback(routeSummary(world.graph, after)), before)
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

    Taxi: ({ via, holdShort: hs }) => {
      const tokens = resolveTaxiTokens(graph, via)
      if ('error' in tokens) {
        return fail(tokens.error)
      }
      const taxied = beginTaxi(world, a, tokens.names, tokens.gate, null)
      if ('error' in taxied) {
        return fail(taxied.error)
      }
      return withTaxiReadback(world, taxied, hs, (summary) =>
        summary.length > 0 ? phrase('taxi via', ...summary) : phrase('taxi via the ramp'),
      )
    },

    Runway: ({ runway, via, holdShort: hs }) => {
      if (graph.runwayEnds[runway] === undefined) {
        return fail(`no runway ${runway}`)
      }
      const tokens = resolveTaxiTokens(graph, via)
      if ('error' in tokens) {
        return fail(tokens.error)
      }
      const taxied = beginTaxi(world, a, tokens.names, null, runway)
      if ('error' in taxied) {
        return fail(taxied.error)
      }
      return withTaxiReadback(world, taxied, hs, (summary) =>
        summary.length > 0
          ? phrase('runway', runwayToken(runway), ', taxi via', ...summary)
          : phrase('runway', runwayToken(runway), ', taxi via the field'),
      )
    },

    HoldShort: ({ point }) => holdShort(graph, a, point),

    Cross: ({ runway }) => cross(graph, a, runway),

    Resume: () => {
      if (a.holdLeg !== null) {
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

    LineUpAndWait: () => {
      const end = a.runway !== null ? graph.runwayEnds[a.runway] : undefined
      if (end === undefined) {
        return fail('no departure runway assigned — use RWY first')
      }
      const cleared = a.cleared.includes(end.runway) ? a.cleared : [...a.cleared, end.runway]
      const route = findPath(graph, nearestNode(graph, a.position), end.chain[0]!, { runwayPenalty: 0 })
      if (route === null) {
        return fail('cannot reach the runway')
      }
      return reply(
        { ...withPath(graph, { ...a, cleared }, route), holdLeg: null, state: 'TAXI', lineUpAfterTaxi: true },
        phrase('line up and wait'),
      )
    },

    ClearedForTakeoff: () => {
      const end = a.runway !== null ? graph.runwayEnds[a.runway] : undefined
      if (end === undefined) {
        return fail('no departure runway assigned')
      }
      const cleared = a.cleared.includes(end.runway) ? a.cleared : [...a.cleared, end.runway]
      const near = nearestNode(graph, a.position)
      const onRunway = end.chain.includes(near)
      const startNode = onRunway ? near : end.chain[0]!
      const chain = end.chain.slice(end.chain.indexOf(startNode))
      let nodes: ReadonlyArray<number>
      if (onRunway) {
        nodes = chain
      } else {
        const route = findPath(graph, near, end.chain[0]!, { runwayPenalty: 0 })
        if (route === null) {
          return fail('cannot reach the runway')
        }
        nodes = [...route, ...chain.slice(1)]
      }
      return reply(
        { ...withPath(graph, { ...a, cleared }, nodes), holdLeg: null, state: 'TKOF', lineUpAfterTaxi: false },
        phrase('cleared for takeoff runway', runwayToken(a.runway ?? '')),
      )
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
      const d = world.airport.departure
      const readback =
        d === null
          ? phrase('contact departure')
          : d.freq !== null
            ? phrase(`over to ${d.radio}`, frequency(d.freq))
            : phrase(`over to ${d.radio}`)
      return reply({ ...a, handoff: true, handoffAt: world.simTime }, readback)
    },

    FlyHeading: ({ heading, turn }) => {
      if (a.state !== 'AIRB') {
        return fail('not airborne')
      }
      const lead = turn === 'L' ? 'turn left heading' : turn === 'R' ? 'turn right heading' : 'heading'
      return reply({ ...a, targetHeading: heading % 360, turn }, phrase(lead, digits(String(heading).padStart(3, '0'))))
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
        return reply(a, a.runway !== null ? phrase('expecting runway', runwayToken(a.runway)) : phrase('no runway assigned'))
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
  const next = command._tag === 'Delete' ? removeAircraft(world, callsign) : replaceAircraft(world, out.aircraft)
  return { world: next, events: out.events }
}
