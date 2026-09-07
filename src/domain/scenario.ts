/**
 * Scenario loading (docs/REWRITE.md section 5, "Scenario loading"): parked,
 * holding-short and on-final aircraft from a catalog scenario.
 */
import { type Aircraft, makeAircraft, performance } from './aircraft'
import type { LonLat, Scenario } from './catalog'
import { bearingDeg, headingDiff, movePoint, reciprocal } from './geo'
import { holdNodeFor, runwayCourse } from './graph'
import { expandNavigationPath } from './navdata'
import { checkIn, checkInAirborne, placeOnFinal, withPath } from './physics'
import { type Prng, nextInt } from './prng'
import { SimEvent, type World, type WorldResult } from './world'

export const QUEUE_SPACING_FT = 260
export const DEFAULT_FINAL_NM = 5
export const DEFAULT_AIRBORNE_KT = 250
/** an "airborne" start this close to the field elevation is a departure still on the ground … */
export const GROUND_START_FT = 150
/** … and the tower launches those one per runway every so often instead of all at once */
export const DEPARTURE_GAP_S = 120

export const fieldElevation = (world: World): number => world.airport.elevation

/** The runway end whose course is nearest a heading: where a ground-level "airborne" start departs from. */
export const departureRunwayFor = (world: World, heading: number): string | null => {
  let best: string | null = null
  let bestDiff = Infinity
  for (const name of Object.keys(world.graph.runwayEnds)) {
    const course = runwayCourse(world.graph, name)
    if (course === null) {
      continue
    }
    const d = headingDiff(course, heading)
    if (d < bestDiff) {
      bestDiff = d
      best = name
    }
  }
  return best
}

/** "I30L" / "ILS 30L" / "RNAV 12R" -> the runway, when the field has it. */
export const runwayFromApproach = (world: World, approach: string | null | undefined): string | null => {
  const m = /(\d{1,2}[LRC]?)\s*$/.exec((approach ?? '').toUpperCase())
  return m !== null && world.graph.runwayEnds[m[1]!] !== undefined ? m[1]! : null
}

/** Drop leading fixes that are already behind the aircraft (a start placed past the transition entry). */
export const trimPassed = (world: World, fixes: ReadonlyArray<string>, position: LonLat, heading: number): ReadonlyArray<string> => {
  let rest = fixes
  while (rest.length > 1) {
    const c = world.nav.fixes[rest[0]!]
    if (c === undefined || headingDiff(heading, bearingDeg(world.graph.projection, position, c)) <= 100) {
      break
    }
    rest = rest.slice(1)
  }
  return rest
}

export const loadScenario = (world: World, scenario: Scenario | null): WorldResult => {
  const graph = world.graph
  const aircraft: Array<Aircraft> = []
  const events: Array<SimEvent> = []
  let prng: Prng = world.prng
  let skipped = 0
  let airborneLoaded = 0
  const launchQueue: Record<string, number> = {}
  for (const r of scenario?.ac ?? []) {
    const [squawk, next] = nextInt(prng, 6000)
    prng = next
    if (aircraft.some((a) => a.callsign === r.cs)) {
      skipped++
      continue
    }
    const base = makeAircraft({
      callsign: r.cs,
      type: r.ty,
      departure: r.dep,
      destination: r.dst,
      delay: r.d,
      squawk: String(1000 + squawk),
      transponder: 'S',
      flightPlan: {
        rules: r.r || 'I',
        fullType: r.tyf ?? null,
        route: r.rte ?? null,
        cruiseAltitude: r.alt ?? null,
        cruiseSpeed: r.spd ?? null,
        remarks: r.rmk ?? null,
        sid: r.sid ?? null,
        star: r.star ?? null,
        approach: r.app ?? null,
      },
    })
    const at = r.at.toUpperCase()
    if (r.k === 'P') {
      const parking = graph.parking[at]
      if (parking === undefined) {
        skipped++
        continue
      }
      aircraft.push({ ...base, gate: at, position: parking.c, heading: parking.heading, state: 'PARKED' })
    } else if (r.k === 'R') {
      const end = graph.runwayEnds[at]
      const hold = holdNodeFor(graph, at)
      if (end === undefined || hold === null || end.chain.length < 2) {
        skipped++
        continue
      }
      const threshold = graph.nodes[end.chain[0]!]!
      const holdPoint = graph.nodes[hold]!
      const back =
        hold === end.chain[0]
          ? reciprocal(bearingDeg(graph.projection, threshold, graph.nodes[end.chain[1]!]!))
          : bearingDeg(graph.projection, threshold, holdPoint)
      const q = r.q ?? 0
      aircraft.push({
        ...base,
        position: q > 0 ? movePoint(graph.projection, holdPoint, back, q * QUEUE_SPACING_FT) : holdPoint,
        heading: reciprocal(back),
        runway: at,
        state: 'SHORT',
      })
    } else if (r.k === 'A') {
      const pos = r.pos
      if (pos === undefined || r.fa === undefined || !world.rules.loadsAirborne) {
        skipped++
        continue
      }
      if (r.fa <= fieldElevation(world) + GROUND_START_FT) {
        const runway = departureRunwayFor(world, r.hdg ?? 0)
        const end = runway === null ? undefined : graph.runwayEnds[runway]
        if (runway === null || end === undefined) {
          skipped++
          continue
        }
        const queued = launchQueue[runway] ?? 0
        launchQueue[runway] = queued + 1
        airborneLoaded++
        aircraft.push({
          ...withPath(graph, { ...base, position: graph.nodes[end.chain[0]!]!, heading: runwayCourse(graph, runway) ?? 0, runway, cleared: [end.runway], state: 'TKOF' }, end.chain),
          holdLeg: null,
          transponder: 'N',
          tracked: true,
          delay: Math.max(r.d, queued * DEPARTURE_GAP_S),
        })
        continue
      }
      const expanded = r.nav !== undefined ? expandNavigationPath(world.nav, r.nav, pos) : { fixes: [], runway: null, procedure: null }
      const firstFix = expanded.fixes[0] !== undefined ? world.nav.fixes[expanded.fixes[0]] : undefined
      const heading = r.hdg ?? (firstFix !== undefined ? bearingDeg(graph.projection, pos, firstFix) : 0)
      const speed = r.ias ?? DEFAULT_AIRBORNE_KT
      const runway = expanded.runway !== null && graph.runwayEnds[expanded.runway] !== undefined ? expanded.runway : runwayFromApproach(world, r.app)
      airborneLoaded++
      aircraft.push({
        ...base,
        state: 'AIRB',
        position: pos,
        heading,
        targetHeading: heading,
        altitude: r.fa,
        targetAltitude: r.fa,
        speed,
        targetSpeed: speed,
        verticalSpeed: performance(r.ty, world.airport.init).verticalSpeed,
        fixes: trimPassed(world, expanded.fixes, pos, heading),
        runway,
        transponder: 'N',
        tracked: true,
        airborneAt: 0,
        checkedIn: r.d <= 0,
        flightPlan: expanded.procedure !== null && base.flightPlan.star === null ? { ...base.flightPlan, star: expanded.procedure } : base.flightPlan,
      })
    } else {
      if (graph.runwayEnds[at] === undefined) {
        skipped++
        continue
      }
      const nm = r.nm ?? DEFAULT_FINAL_NM
      aircraft.push({
        ...placeOnFinal(graph, base, at, nm),
        transponder: 'N',
        tracked: true,
        clearedToLand: !world.rules.requireLandingClearance,
      })
    }
  }
  const next: World = {
    ...world,
    aircraft,
    prng,
    simTime: 0,
    tick: 0,
    nextArrivalAt: 0,
    scenario: scenario === null ? null : { id: scenario.id, name: scenario.name, gen: scenario.gen },
  }
  if (scenario === null) {
    events.push(SimEvent.SystemNote({ text: `${world.airport.name} — empty field. Switch on Arrivals, or pick a scenario.` }))
  } else {
    const surface = aircraft.length - airborneLoaded
    const notLoaded = scenario.air - airborneLoaded
    const missingNav = notLoaded > 0 && world.rules.loadsAirborne && Object.keys(world.nav.fixes).length === 0
    events.push(
      SimEvent.SystemNote({
        text: `${scenario.name} — ${surface} surface aircraft${airborneLoaded ? `, ${airborneLoaded} airborne` : ''}${
          notLoaded > 0 ? `, ${notLoaded} airborne not loaded${missingNav ? ' (catalog built without nav data)' : ''}` : ''
        }${skipped - Math.max(0, notLoaded) > 0 ? `, ${skipped - Math.max(0, notLoaded)} unplaced` : ''}.${scenario.stu ? ` Student position ${scenario.stu}.` : ''}`,
      }),
    )
  }
  for (const a of aircraft) {
    if (a.state === 'FINAL' && world.rules.checkInOnFinal) {
      const nm = scenario?.ac.find((r) => r.cs === a.callsign)?.nm ?? DEFAULT_FINAL_NM
      events.push(checkIn(next, a, nm))
    } else if (a.state === 'AIRB' && a.delay <= 0 && world.rules.checkInAirborne) {
      events.push(checkInAirborne(next, a))
    }
  }
  return { world: next, events }
}
