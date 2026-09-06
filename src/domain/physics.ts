/**
 * The physics step (docs/REWRITE.md section 5: "Ground physics", "Takeoff and
 * flight", "Arrivals", "Radar"). `stepWorld` advances every aircraft by one fixed
 * step and returns the next World with the events that happened.
 */
import { type Aircraft, isRadarVisible, makeAircraft, performance } from './aircraft'
import type { LonLat } from './catalog'
import {
  FT_PER_NM,
  KT_TO_FT_PER_S,
  bearingDeg,
  distanceFt,
  headingDiff,
  movePoint,
  nmFromCenter,
  radarProjectionAt,
  reciprocal,
  turnDelta,
} from './geo'
import { type Graph, edgeName, gateNames, isRunwayName, nearestNode, runwayCourse } from './graph'
import { type Phrase, callsign as callsignToken, gate as gateToken, numberWords, phrase, runway as runwayToken, taxiways } from './phrase'
import { nextBetween, nextInt, pick, pickWeighted } from './prng'
import { findPath } from './route'
import { SimEvent, type World, type WorldResult, findAircraft, removeAircraft, replaceAircraft, towerRadioName } from './world'

export const SIM_STEP_S = 0.1
export const MAX_STEPS_PER_TICK = 40
export const TAXI_KT = 16
export const TURN_KT = 9
export const PUSH_KT = 4
export const ROLL_KT = 150
export const TURN_SLOW_DEG = 32
export const CONFLICT_FT = 340
export const CONFLICT_CONE_DEG = 38
export const CONFLICT_SLOW_KT = 7
export const CONFLICT_STOP_FT = 180
export const GIVE_WAY_CLEAR_FT = 420
export const BREAK_S = 15
export const FINAL_KT = 140
export const GLIDE_FT_PER_NM = 318
export const GO_AROUND_KT = 160
export const HANDOFF_REMOVE_S = 20
export const RADAR_LIMIT_NM = 16
export const IDENT_S = 4
export const ARRIVAL_GAP_MIN_S = 70
export const ARRIVAL_GAP_MAX_S = 110
export const FALLBACK_FLEET = [{ a: 'N', w: 1, t: ['C172', 'BE36', 'C56X', 'PC12'] }]

export type StepOut = Readonly<{ aircraft: Aircraft | null; events: ReadonlyArray<SimEvent> }>

const said = (a: Aircraft, p: Phrase): SimEvent => SimEvent.PilotSaid({ callsign: a.callsign, phrase: p })
const note = (text: string): SimEvent => SimEvent.SystemNote({ text })
const keep = (aircraft: Aircraft, events: ReadonlyArray<SimEvent> = []): StepOut => ({ aircraft, events })

// PATHS

export const legRunway = (graph: Graph, a: Aircraft, i: number): string | null =>
  a.path !== null && i + 1 < a.path.length ? edgeName(graph, a.path[i]!, a.path[i + 1]!) : null

const firstRunwayLegOf = (
  graph: Graph,
  path: ReadonlyArray<number>,
  from: number,
  cleared: ReadonlyArray<string>,
): number | null => {
  for (let i = from; i + 1 < path.length; i++) {
    const name = edgeName(graph, path[i]!, path[i + 1]!)
    if (name !== null && isRunwayName(graph, name) && !cleared.includes(name)) {
      return i
    }
  }
  return null
}

export const firstRunwayLeg = (graph: Graph, a: Aircraft, from: number): number | null =>
  a.path === null ? null : firstRunwayLegOf(graph, a.path, from, a.cleared)

/** Start following `nodes` from the current position; arms the first uncleared runway. */
export const withPath = (graph: Graph, a: Aircraft, nodes: ReadonlyArray<number>): Aircraft => ({
  ...a,
  path: nodes,
  leg: 0,
  frac: 0,
  origin: a.position,
  holdLeg: firstRunwayLegOf(graph, nodes, 0, a.cleared),
})

const legPoints = (
  graph: Graph,
  path: ReadonlyArray<number>,
  leg: number,
  origin: LonLat | null,
): readonly [LonLat, LonLat] => [
  leg === 0 && origin !== null ? origin : graph.nodes[path[leg]!]!,
  graph.nodes[path[leg + 1]!]!,
]

const advance = (graph: Graph, tick: number, a: Aircraft, dt: number): Aircraft => {
  if (a.path === null) {
    return a
  }
  const path = a.path
  const proj = graph.projection
  let move = a.speed * KT_TO_FT_PER_S * dt
  let leg = a.leg
  let frac = a.frac
  let origin = a.origin
  let holdLeg = a.holdLeg
  while (move > 0 && leg < path.length - 1) {
    const [c, d] = legPoints(graph, path, leg, origin)
    const len = Math.max(distanceFt(proj, c, d), 1)
    const remaining = (1 - frac) * len
    if (move < remaining) {
      frac += move / len
      move = 0
    } else {
      move -= remaining
      leg++
      frac = 0
      origin = null
      if (holdLeg !== null && leg > holdLeg) {
        holdLeg = firstRunwayLegOf(graph, path, leg, a.cleared)
      }
    }
  }
  let position: LonLat
  let heading = a.heading
  if (leg < path.length - 1) {
    const [c, d] = legPoints(graph, path, leg, origin)
    position = [c[0] + (d[0] - c[0]) * frac, c[1] + (d[1] - c[1]) * frac]
    const course = bearingDeg(proj, c, d)
    heading = a.state === 'PUSH' ? reciprocal(course) : course
  } else {
    position = graph.nodes[path[path.length - 1]!]!
  }
  const history = tick % 10 === 0 ? [...a.history, position].slice(-6) : a.history
  return { ...a, leg, frac, origin, holdLeg, position, heading, history }
}

const atPathEnd = (a: Aircraft): boolean => a.path === null || a.leg >= a.path.length - 1

// FLIGHT

export const liftoff = (world: World, a: Aircraft): StepOut => {
  const pf = performance(a.type, world.airport.init)
  const course = (a.runway !== null ? runwayCourse(world.graph, a.runway) : null) ?? a.heading
  return keep(
    {
      ...a,
      state: 'AIRB',
      heading: course,
      targetHeading: course,
      turn: null,
      altitude: 0,
      targetAltitude: pf.initialAltitude,
      targetSpeed: pf.climbSpeed,
      verticalSpeed: pf.verticalSpeed,
      path: null,
      holdLeg: null,
      transponder: a.transponder === 'S' ? 'N' : a.transponder,
      airborneAt: world.simTime,
    },
    [note(`${a.callsign} airborne runway ${a.runway}, climbing ${pf.initialAltitude}`)],
  )
}

export const goAround = (world: World, a: Aircraft, why: string | null): StepOut => {
  const course = (a.runway !== null ? runwayCourse(world.graph, a.runway) : null) ?? a.heading
  const next: Aircraft = {
    ...a,
    state: 'AIRB',
    heading: course,
    targetHeading: course,
    turn: null,
    altitude: Math.max(a.altitude, 50),
    targetAltitude: Math.max(3000, world.airport.init.pattern + 1500),
    targetSpeed: GO_AROUND_KT,
    verticalSpeed: performance(a.type, world.airport.init).verticalSpeed,
    path: null,
    clearedToLand: false,
    destinationGate: null,
    goingAround: true,
  }
  return keep(next, [said(next, phrase(why !== null ? `going around, ${why}` : 'going around'))])
}

const stepAir = (world: World, a: Aircraft, dt: number): StepOut => {
  let delta = turnDelta(a.heading, a.targetHeading)
  if (a.turn === 'L' && delta > 0) {
    delta -= 360
  }
  if (a.turn === 'R' && delta < 0) {
    delta += 360
  }
  const rate = 3 * dt
  const reached = Math.abs(delta) <= rate
  const heading = reached ? a.targetHeading : (a.heading + Math.sign(delta) * rate + 360) % 360
  const turn = reached ? null : a.turn
  const speed =
    a.speed < a.targetSpeed ? Math.min(a.targetSpeed, a.speed + 3 * dt) : Math.max(a.targetSpeed, a.speed - 2 * dt)
  const climb = ((a.verticalSpeed || 2000) / 60) * dt
  const altitude =
    a.altitude < a.targetAltitude
      ? Math.min(a.targetAltitude, a.altitude + climb)
      : a.altitude > a.targetAltitude
        ? Math.max(a.targetAltitude, a.altitude - climb * 0.6)
        : a.altitude
  const position = movePoint(world.graph.projection, a.position, heading, speed * KT_TO_FT_PER_S * dt)
  const history = world.tick % 10 === 0 ? [...a.history, position].slice(-6) : a.history
  const next: Aircraft = { ...a, heading, turn, speed, altitude, position, history }
  if (next.handoff && world.simTime - next.handoffAt > HANDOFF_REMOVE_S) {
    return {
      aircraft: null,
      events: [
        SimEvent.Removed({
          callsign: a.callsign,
          text: `${a.callsign} with ${world.airport.departure?.radio ?? 'departure'}`,
        }),
      ],
    }
  }
  const center = world.airport.radarCenter
  const distanceNm = center === null ? 0 : nmFromCenter(radarProjectionAt(center[1]), center, position)
  if (distanceNm > RADAR_LIMIT_NM) {
    return {
      aircraft: null,
      events: [
        SimEvent.Removed({
          callsign: a.callsign,
          text: `${a.callsign} left the area${next.handoff ? '' : ' without a frequency change'}`,
        }),
      ],
    }
  }
  return keep(next)
}

// GROUND

/** Leave the runway at the nearest non-runway node, then taxi to the destination gate if any. */
export const autoExit = (world: World, a: Aircraft): StepOut => {
  const graph = world.graph
  const end = a.runway !== null ? graph.runwayEnds[a.runway] : undefined
  let exitNode: number | null = null
  let best = Infinity
  for (const n of end?.chain ?? []) {
    for (const e of graph.adjacency[n] ?? []) {
      if (isRunwayName(graph, e.name)) {
        continue
      }
      const d = distanceFt(graph.projection, graph.nodes[e.to]!, a.position)
      if (d < best) {
        best = d
        exitNode = e.to
      }
    }
  }
  const slowed: Aircraft = { ...a, speed: 6 }
  if (exitNode === null || end === undefined) {
    const held: Aircraft = { ...slowed, state: 'HOLD', runway: null }
    return keep(held, [said(held, phrase('clear of the runway'))])
  }
  const cleared = slowed.cleared.includes(end.runway) ? slowed.cleared : [...slowed.cleared, end.runway]
  const toExit = findPath(graph, nearestNode(graph, a.position), exitNode, { runwayPenalty: 0 })
  const gateNode = a.destinationGate !== null ? graph.parking[a.destinationGate]?.node : undefined
  const onward = gateNode !== undefined && toExit !== null ? findPath(graph, exitNode, gateNode) : null
  const nodes = toExit === null ? null : onward !== null ? [...toExit, ...onward.slice(1)] : toExit
  const routed: Aircraft =
    nodes === null
      ? { ...slowed, cleared, state: 'HOLD', runway: null }
      : { ...withPath(graph, { ...slowed, cleared }, nodes), state: 'TAXI', holdLeg: null, runway: null }
  const exitName = graph.nodeTaxiways[exitNode]?.[0]
  return keep(
    routed,
    [said(routed, exitName !== undefined ? phrase('clear of the runway at', taxiways([exitName])) : phrase('clear of the runway'))],
  )
}

const arriveEnd = (world: World, a: Aircraft): StepOut => {
  if (a.state === 'PUSH') {
    const next: Aircraft = { ...a, state: 'PUSHED', speed: 0 }
    return keep(next, [said(next, phrase('ready to taxi'))])
  }
  if (a.state === 'TAXI' || a.state === 'SHORT') {
    const stopped: Aircraft = { ...a, speed: 0 }
    if (stopped.lineUpAfterTaxi) {
      const next: Aircraft = { ...stopped, lineUpAfterTaxi: false, state: 'LUAW' }
      return keep(next, [said(next, phrase('lined up runway', runwayToken(a.runway ?? '')))])
    }
    if (stopped.destinationGate !== null) {
      const parking = world.graph.parking[stopped.destinationGate]
      const next: Aircraft = {
        ...stopped,
        state: 'PARKED',
        gate: stopped.destinationGate,
        destinationGate: null,
        position: parking?.c ?? stopped.position,
        heading: parking?.heading ?? stopped.heading,
      }
      return keep(next, [said(next, phrase('in the blocks at', gateToken(next.gate ?? '')))])
    }
    if (stopped.runway !== null) {
      const next: Aircraft = { ...stopped, state: 'SHORT' }
      return keep(next, [said(next, phrase('holding short of', runwayToken(stopped.runway)))])
    }
    const next: Aircraft = { ...stopped, state: 'HOLD' }
    return keep(next, [said(next, phrase('holding'))])
  }
  return keep(a)
}

const aheadConflict = (world: World, a: Aircraft): Aircraft | null => {
  if (world.simTime < a.breakUntil) {
    return null
  }
  const proj = world.graph.projection
  for (const b of world.aircraft) {
    if (b.callsign === a.callsign || b.state === 'PARKED' || b.state === 'FINAL' || b.state === 'AIRB' || b.delay > 0) {
      continue
    }
    const d = distanceFt(proj, a.position, b.position)
    if (d > CONFLICT_FT || d < 1) {
      continue
    }
    const relative = turnDelta(a.heading, bearingDeg(proj, a.position, b.position))
    if (Math.abs(relative) < CONFLICT_CONE_DEG) {
      return b
    }
  }
  return null
}

const turnAhead = (graph: Graph, a: Aircraft): number => {
  if (a.path === null || a.leg + 2 >= a.path.length) {
    return 0
  }
  const [c, d] = legPoints(graph, a.path, a.leg, a.origin)
  const e = graph.nodes[a.path[a.leg + 2]!] ?? d
  return headingDiff(bearingDeg(graph.projection, c, d), bearingDeg(graph.projection, d, e))
}

const holdPointPhrase = (graph: Graph, name: string): Phrase =>
  isRunwayName(graph, name) || graph.runwayEnds[name] !== undefined
    ? phrase('holding short of', runwayToken(name))
    : phrase('holding short of', taxiways([name]))

const stepGround = (world: World, a: Aircraft, dt: number): StepOut => {
  const graph = world.graph
  const proj = graph.projection
  const conflict = a.giveWayTo !== null ? (findAircraft(world, a.giveWayTo) ?? null) : aheadConflict(world, a)
  const holdHere = a.holdLeg !== null && a.leg >= a.holdLeg
  let want = a.state === 'PUSH' ? PUSH_KT : turnAhead(graph, a) > TURN_SLOW_DEG ? TURN_KT : TAXI_KT
  if (holdHere) {
    want = 0
  }
  let blockedBy: string | null = null
  if (conflict !== null && a.state !== 'PUSH') {
    const d = distanceFt(proj, a.position, conflict.position)
    want = d < CONFLICT_STOP_FT ? 0 : Math.min(want, CONFLICT_SLOW_KT)
    blockedBy = conflict.callsign
  }
  const giveWayTo =
    a.giveWayTo !== null && conflict !== null && distanceFt(proj, a.position, conflict.position) > GIVE_WAY_CLEAR_FT
      ? null
      : a.giveWayTo
  const speed = a.speed < want ? Math.min(want, a.speed + 5 * dt) : Math.max(want, a.speed - 8 * dt)
  const moving: Aircraft = { ...a, speed, blockedBy, giveWayTo }
  if (holdHere && speed < 0.4) {
    const stopped: Aircraft = { ...moving, speed: 0 }
    if (stopped.state !== 'SHORT') {
      const next: Aircraft = { ...stopped, state: 'SHORT' }
      const name = (a.holdLeg !== null ? legRunway(graph, a, a.holdLeg) : null) ?? a.runway
      return keep(next, [said(next, name !== null ? holdPointPhrase(graph, name) : phrase('holding short of the runway'))])
    }
    return keep(stopped)
  }
  if (moving.path === null) {
    return keep({ ...moving, speed: 0, state: 'HOLD' })
  }
  const advanced = advance(graph, world.tick, moving, dt)
  return atPathEnd(advanced) ? arriveEnd(world, advanced) : keep(advanced)
}

// ONE AIRCRAFT

const onFrequencyNote = (a: Aircraft): string =>
  `${a.callsign} ${a.type} on frequency — ${a.gate !== null ? `at ${a.gate}` : a.runway !== null ? `holding short ${a.runway}` : 'ready'}`

export const stepAircraft = (world: World, input: Aircraft, dt: number): StepOut => {
  const a: Aircraft =
    input.transponder === 'I' && world.simTime >= input.identUntil ? { ...input, transponder: 'N' } : input
  if (a.delay > 0) {
    const delay = a.delay - dt
    const next: Aircraft = { ...a, delay }
    return keep(next, delay <= 0 ? [note(onFrequencyNote(next))] : [])
  }
  const graph = world.graph
  if (a.state === 'PARKED') {
    return keep(a)
  }
  if (a.state === 'AIRB') {
    return stepAir(world, a, dt)
  }
  if (a.state === 'TKOF') {
    const pf = performance(a.type, world.airport.init)
    const rolling = advance(graph, world.tick, { ...a, speed: Math.min(ROLL_KT, a.speed + pf.accel * dt) }, dt)
    return rolling.speed >= pf.vr || atPathEnd(rolling) ? liftoff(world, rolling) : keep(rolling)
  }
  if (a.state === 'FINAL') {
    const flown = advance(graph, world.tick, { ...a, speed: FINAL_KT }, dt)
    let onFinal: Aircraft
    if (flown.leg >= 1) {
      onFinal = { ...flown, altitude: 0, landed: true }
    } else {
      const end = a.runway !== null ? graph.runwayEnds[a.runway] : undefined
      const threshold = end !== undefined ? graph.nodes[end.chain[0]!] : undefined
      const distanceNm = threshold !== undefined ? distanceFt(graph.projection, flown.position, threshold) / FT_PER_NM : 0
      onFinal = { ...flown, altitude: Math.max(0, distanceNm * GLIDE_FT_PER_NM) }
      if (world.rules.requireLandingClearance && !onFinal.clearedToLand && distanceNm < 1) {
        return goAround(world, onFinal, 'no landing clearance')
      }
    }
    return atPathEnd(onFinal) ? keep({ ...onFinal, state: 'ROLLOUT', altitude: 0 }) : keep(onFinal)
  }
  if (a.state === 'ROLLOUT') {
    const rolled = advance(graph, world.tick, { ...a, speed: Math.max(18, a.speed - 9 * dt) }, dt)
    return rolled.speed <= 19 ? autoExit(world, rolled) : keep(rolled)
  }
  if (a.state === 'HOLD' || a.state === 'LUAW' || a.state === 'PUSHED' || a.state === 'SHORT') {
    return keep({ ...a, speed: Math.max(0, a.speed - 14 * dt) })
  }
  return stepGround(world, a, dt)
}

// ARRIVALS

export const placeOnFinal = (graph: Graph, a: Aircraft, runway: string, nm: number): Aircraft => {
  const end = graph.runwayEnds[runway]
  if (end === undefined || end.chain.length < 2) {
    return a
  }
  const threshold = graph.nodes[end.chain[0]!]!
  const course = bearingDeg(graph.projection, threshold, graph.nodes[end.chain[1]!]!)
  const position = movePoint(graph.projection, threshold, reciprocal(course), nm * FT_PER_NM)
  return {
    ...a,
    position,
    heading: course,
    speed: FINAL_KT,
    altitude: nm * GLIDE_FT_PER_NM,
    state: 'FINAL',
    runway,
    landed: false,
    origin: position,
    path: end.chain,
    leg: 0,
    frac: 0,
    holdLeg: null,
  }
}

/** "Minneapolis Tower, Delta ten forty-seven, six mile final, runway three zero right" */
export const checkIn = (world: World, a: Aircraft, nm: number): SimEvent =>
  said(
    a,
    phrase(
      `${towerRadioName(world)},`,
      callsignToken(a.callsign),
      `, ${numberWords(Math.round(nm))} mile final, runway`,
      runwayToken(a.runway ?? ''),
    ),
  )

export const maybeArrival = (world: World): WorldResult => {
  if (!world.arrivalsEnabled || world.simTime < world.nextArrivalAt) {
    return { world, events: [] }
  }
  const [gap, p1] = nextBetween(world.prng, ARRIVAL_GAP_MIN_S, ARRIVAL_GAP_MAX_S)
  const scheduled: World = { ...world, prng: p1, nextArrivalAt: world.simTime + gap }
  const generatorRunways = (world.scenario?.gen ?? []).filter((r) => world.graph.runwayEnds[r] !== undefined)
  const landing = generatorRunways.length > 0 ? generatorRunways : Object.keys(world.graph.runwayEnds)
  if (landing.length === 0) {
    return { world: scheduled, events: [] }
  }
  const [runway, p2] = pick(p1, landing)
  const fleet = world.airport.fleet.length > 0 ? world.airport.fleet : FALLBACK_FLEET
  const [entry, p3] = pickWeighted(p2, fleet, (f) => f.w)
  const [number, p4] = nextInt(p3, 899)
  const [type, p5] = pick(p4, entry?.t ?? [])
  const [squawk, p6] = nextInt(p5, 6000)
  const [destinationGate, p7] = pick(p6, gateNames(world.graph))
  const callsign = `${entry?.a ?? 'N'}${100 + number}`
  const next: World = { ...scheduled, prng: p7 }
  if (runway === undefined || findAircraft(world, callsign) !== undefined) {
    return { world: next, events: [] }
  }
  const nm = world.rules.arrivalFinalNm
  const arrival: Aircraft = {
    ...placeOnFinal(
      world.graph,
      makeAircraft({
        callsign,
        type: type ?? 'C172',
        destination: world.airport.id,
        transponder: 'N',
        squawk: String(1000 + squawk),
      }),
      runway,
      nm,
    ),
    tracked: true,
    clearedToLand: !world.rules.requireLandingClearance,
    destinationGate: destinationGate ?? null,
  }
  const events: Array<SimEvent> = [
    note(
      `${arrival.callsign} ${arrival.type} ${world.rules.checkInOnFinal ? `${nm} mile final` : 'on final'} runway ${runway}${
        arrival.destinationGate !== null ? `, parking ${arrival.destinationGate}` : ''
      }`,
    ),
  ]
  if (world.rules.checkInOnFinal) {
    events.push(checkIn(world, arrival, nm))
  }
  return { world: { ...next, aircraft: [...next.aircraft, arrival] }, events }
}

// RADAR

const radarSweep = (aircraft: ReadonlyArray<Aircraft>): ReadonlyArray<Aircraft> =>
  aircraft.map((a) =>
    isRadarVisible(a)
      ? {
          ...a,
          radar: {
            position: a.position,
            altitude: a.altitude,
            speed: a.speed,
            history: (a.radar === null ? [] : [...a.radar.history, a.radar.position]).slice(-5),
          },
        }
      : { ...a, radar: null },
  )

// WORLD

export const stepWorld = (world: World, dt: number = SIM_STEP_S): WorldResult => {
  const clock: World = { ...world, tick: world.tick + 1, simTime: world.simTime + dt }
  const events: Array<SimEvent> = []
  const aircraft: Array<Aircraft> = []
  for (const a of world.aircraft) {
    const out = stepAircraft(clock, a, dt)
    events.push(...out.events)
    if (out.aircraft !== null) {
      aircraft.push(out.aircraft)
    }
  }
  const arrival = maybeArrival({ ...clock, aircraft })
  events.push(...arrival.events)
  const swept = clock.tick % 10 === 0 ? { ...arrival.world, aircraft: radarSweep(arrival.world.aircraft) } : arrival.world
  return { world: swept, events }
}

/** Run `steps` fixed steps, collecting events. */
export const stepWorldTimes = (world: World, steps: number): WorldResult => {
  let current = world
  const events: Array<SimEvent> = []
  for (let i = 0; i < steps; i++) {
    const out = stepWorld(current)
    current = out.world
    events.push(...out.events)
  }
  return { world: current, events }
}

export { replaceAircraft, removeAircraft }
