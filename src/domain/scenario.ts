/**
 * Scenario loading (docs/REWRITE.md section 5, "Scenario loading"): parked,
 * holding-short and on-final aircraft from a catalog scenario.
 */
import { type Aircraft, makeAircraft } from './aircraft'
import type { Scenario } from './catalog'
import { bearingDeg, movePoint, reciprocal } from './geo'
import { holdNodeFor } from './graph'
import { checkIn, placeOnFinal } from './physics'
import { type Prng, nextInt } from './prng'
import { SimEvent, type World, type WorldResult } from './world'

export const QUEUE_SPACING_FT = 260
export const DEFAULT_FINAL_NM = 5

export const loadScenario = (world: World, scenario: Scenario | null): WorldResult => {
  const graph = world.graph
  const aircraft: Array<Aircraft> = []
  const events: Array<SimEvent> = []
  let prng: Prng = world.prng
  let skipped = 0
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
    events.push(
      SimEvent.SystemNote({
        text: `${scenario.name} — ${aircraft.length} surface aircraft${scenario.air ? `, ${scenario.air} airborne not loaded` : ''}${
          skipped ? `, ${skipped} unplaced` : ''
        }.${scenario.stu ? ` Student position ${scenario.stu}.` : ''}`,
      }),
    )
  }
  if (world.rules.checkInOnFinal) {
    for (const a of aircraft) {
      if (a.state === 'FINAL') {
        const nm = scenario?.ac.find((r) => r.cs === a.callsign)?.nm ?? DEFAULT_FINAL_NM
        events.push(checkIn(next, a, nm))
      }
    }
  }
  return { world: next, events }
}
