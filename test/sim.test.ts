import { describe, expect, test } from 'bun:test'

import { isProp, performance } from '../src/domain/aircraft'
import { distanceFt, headingDiff } from '../src/domain/geo'
import { edgeName, holdNodeFor, isRunwayName, runwayCourse, runwaysEntered } from '../src/domain/graph'
import { spoken, written } from '../src/domain/phrase'
import { stepWorld } from '../src/domain/physics'
import { GROUND_RULES, LOCAL_RULES } from '../src/domain/rules'
import { loadScenario } from '../src/domain/scenario'
import { findAircraft, makeWorld } from '../src/domain/world'
import { aircraftNamed, command, emptyWorld, groundWorld, msp, pilotLines, refusal, run, runUntil, scenarioNamed, scenarioPlacing, stateOf, systemLines } from './helpers'
import { DEPARTURE_TURN_AGL_FT, autoExit, withPath } from '../src/domain/physics'

const AAL = 'AAL894'

describe('scenario loading', () => {
  test('parks every placed aircraft at its gate with the gate heading and a fresh squawk', () => {
    const world = groundWorld()
    expect(world.aircraft).toHaveLength(82)
    const a = aircraftNamed(world, AAL)
    expect(a.state).toBe('PARKED')
    expect(a.gate).toBe('E16')
    expect(a.position).toEqual(world.graph.parking['E16']!.c)
    expect(a.heading).toBe(world.graph.parking['E16']!.heading)
    expect(Number(a.squawk)).toBeGreaterThanOrEqual(1000)
    expect(Number(a.squawk)).toBeLessThan(7000)
    expect(a.transponder).toBe('S')
    expect(a.flightPlan.sid).toBe('ZMBRO7')
    expect(a.flightPlan.star).toBe('PARQR3')
    expect(new Set(world.aircraft.map((x) => x.squawk)).size).toBeGreaterThan(70)
  })

  test('announces the scenario', () => {
    const loaded = loadScenario(makeWorld(msp, GROUND_RULES, 1), scenarioNamed('KMSP 12s/17 SLCL 5MIT'))
    expect(systemLines(loaded.events)[0]).toBe('KMSP 12s/17 SLCL 5MIT — 82 surface aircraft, 2 airborne not loaded. Student position MSP_S_GND.')
    const empty = loadScenario(makeWorld(msp, GROUND_RULES, 1), null)
    expect(systemLines(empty.events)[0]).toBe('Minneapolis ATCT — empty field. Switch on Arrivals, or pick a scenario.')
  })

  test('holding-short aircraft queue back from the hold node facing the runway', () => {
    const world = loadScenario(makeWorld(msp, GROUND_RULES, 1), scenarioPlacing('SWA1045', 'R')).world
    const first = aircraftNamed(world, 'SWA1045')
    const second = aircraftNamed(world, 'DAL2313')
    const third = aircraftNamed(world, 'DAL1407')
    const hold = world.graph.nodes[holdNodeFor(world.graph, '17')!]!
    expect(first.state).toBe('SHORT')
    expect(first.runway).toBe('17')
    expect(distanceFt(world.graph.projection, first.position, hold)).toBeLessThan(1)
    expect(distanceFt(world.graph.projection, second.position, hold)).toBeCloseTo(260, 0)
    expect(distanceFt(world.graph.projection, third.position, hold)).toBeCloseTo(520, 0)
    expect(headingDiff(first.heading, second.heading)).toBeLessThan(1)
  })

  test('on-final aircraft start on the glide path, tracked and cleared under Ground rules', () => {
    const world = loadScenario(makeWorld(msp, GROUND_RULES, 1), scenarioPlacing('SKW3892', 'F')).world
    const a = aircraftNamed(world, 'SKW3892')
    const threshold = world.graph.nodes[world.graph.runwayEnds['12R']!.chain[0]!]!
    expect(a.state).toBe('FINAL')
    expect(a.altitude).toBe(8 * 318)
    expect(distanceFt(world.graph.projection, a.position, threshold) / 6076).toBeCloseTo(8, 1)
    expect(a.tracked).toBe(true)
    expect(a.clearedToLand).toBe(true)
    expect(a.transponder).toBe('N')
  })

  test('under Local rules on-final aircraft check in and are not cleared to land', () => {
    const loaded = loadScenario(makeWorld(msp, LOCAL_RULES, 1), scenarioPlacing('SKW3892', 'F'))
    const a = aircraftNamed(loaded.world, 'SKW3892')
    expect(a.clearedToLand).toBe(false)
    const checkIn = loaded.events.find((e) => e._tag === 'PilotSaid' && e.callsign === 'SKW3892')
    expect(checkIn?._tag).toBe('PilotSaid')
    if (checkIn?._tag === 'PilotSaid') {
      expect(written(checkIn.phrase)).toBe('Minneapolis Tower, SKW3892, eight mile final, runway 12R')
      expect(spoken(checkIn.phrase)).toBe('Minneapolis Tower, SkyWest thirty-eight ninety-two, eight mile final, runway one two right')
    }
  })

  test('delayed aircraft are refused until they come on frequency', () => {
    const scenario = msp.scen.find((s) => s.ac.some((a) => a.k === 'P' && a.d > 0))!
    const record = scenario.ac.find((a) => a.k === 'P' && a.d > 0)!
    const world = loadScenario(makeWorld(msp, GROUND_RULES, 1), scenario).world
    expect(refusal(world, `${record.cs} PUSH`)).toBe(`not on frequency yet (spawns in ${Math.ceil(record.d)}s)`)
    const later = run(world, record.d + 0.1)
    expect(systemLines(later.events)).toContain(`${record.cs} ${record.ty} on frequency — at ${record.at}`)
    expect(refusal(later.world, `${record.cs} PUSH`)).toBeNull()
  })
})

describe('pushback and taxi', () => {
  test('PUSH backs off the gate at 4 kt and stops ready to taxi', () => {
    const world = groundWorld()
    const pushed = command(world, `${AAL} PUSH`)
    expect(pilotLines(pushed.events)).toEqual([`${AAL}: pushing back off E16`])
    const a = aircraftNamed(pushed.world, AAL)
    expect(a.state).toBe('PUSH')
    expect(refusal(pushed.world, `${AAL} PUSH`)).toBe('not at a gate')
    const moving = run(pushed.world, 5)
    const m = aircraftNamed(moving.world, AAL)
    expect(m.speed).toBeCloseTo(4, 5)
    expect(headingDiff(m.heading, world.graph.parking['E16']!.heading)).toBeLessThan(90)
    const done = runUntil(pushed.world, stateOf(AAL, 'PUSHED'), 300)
    expect(pilotLines(done.events)).toContain(`${AAL}: ready to taxi`)
    expect(aircraftNamed(done.world, AAL).speed).toBe(0)
    expect(distanceFt(world.graph.projection, aircraftNamed(done.world, AAL).position, world.graph.nodes[world.graph.parking['E16']!.node]!)).toBeLessThan(2)
  })

  test('PUSH onto a named taxiway ends on that taxiway', () => {
    const world = groundWorld()
    const pushed = command(world, `${AAL} PUSH D`)
    const a = aircraftNamed(pushed.world, AAL)
    expect(a.path!.length).toBeGreaterThanOrEqual(2)
    expect(world.graph.taxiways['D']).toContain(a.path![a.path!.length - 1]!)
  })

  test('RWY routes to the hold node, reads back the route and holds short automatically', () => {
    const world = groundWorld()
    const taxied = command(world, `${AAL} RWY 30L`)
    expect(pilotLines(taxied.events)).toEqual([`${AAL}: runway 30L, taxi via D B A`])
    const a = aircraftNamed(taxied.world, AAL)
    expect(a.state).toBe('TAXI')
    expect(a.runway).toBe('30L')
    expect(a.holdLeg).toBeNull()
    expect(a.path![a.path!.length - 1]).toBe(holdNodeFor(world.graph, '30L')!)
    const short = runUntil(taxied.world, stateOf(AAL, 'SHORT'), 900)
    expect(pilotLines(short.events)).toContain(`${AAL}: holding short of 30L`)
    const s = aircraftNamed(short.world, AAL)
    expect(s.speed).toBe(0)
    expect(distanceFt(world.graph.projection, s.position, world.graph.nodes[holdNodeFor(world.graph, '30L')!]!)).toBeLessThan(2)
    expect(short.seconds).toBeGreaterThan(60)
  })

  test('taxi speed is 16 kt, 9 kt into a sharp turn', () => {
    const world = groundWorld()
    const taxied = command(world, `${AAL} RWY 30L`)
    const speeds: Array<number> = []
    let w = taxied.world
    for (let i = 0; i < 1200; i++) {
      w = stepWorld(w).world
      speeds.push(aircraftNamed(w, AAL).speed)
    }
    expect(Math.max(...speeds)).toBeCloseTo(16, 5)
    expect(speeds.some((s) => Math.abs(s - 9) < 0.01)).toBe(true)
  })

  test('TAXI via taxiways and a gate parks at the gate', () => {
    const world = groundWorld()
    const taxied = command(world, `${AAL} TAXI D G16`)
    const a = aircraftNamed(taxied.world, AAL)
    expect(a.destinationGate).toBe('G16')
    expect(a.path![a.path!.length - 1]).toBe(world.graph.parking['G16']!.node)
    const parked = runUntil(taxied.world, stateOf(AAL, 'PARKED'), 900)
    expect(pilotLines(parked.events)).toContain(`${AAL}: in the blocks at G16`)
    expect(aircraftNamed(parked.world, AAL).gate).toBe('G16')
  })

  test('TAXI to a taxiway ends holding at its far end', () => {
    const world = groundWorld()
    const taxied = command(world, `${AAL} TAXI A`)
    const held = runUntil(taxied.world, stateOf(AAL, 'HOLD'), 1200)
    expect(pilotLines(held.events)).toContain(`${AAL}: holding`)
    expect(refusal(held.world, `${AAL} RES`)).toBe('no route to resume — give a taxi instruction')
  })

  test('unknown taxiways and runways are refused', () => {
    const world = groundWorld()
    expect(refusal(world, `${AAL} TAXI ZZ`)).toBe('unfamiliar with ZZ')
    expect(refusal(world, `${AAL} RWY 99`)).toBe('no runway 99')
    expect(refusal(world, `${AAL} HS A`)).toBe('hold short of what?')
  })

  test('HS holds at a taxiway on the route; RES crosses it', () => {
    const world = groundWorld()
    const taxied = command(world, `${AAL} RWY 30L TAXI D HS B`)
    expect(pilotLines(taxied.events)).toEqual([`${AAL}: hold short of B`, `${AAL}: runway 30L, taxi via D A`])
    const a = aircraftNamed(taxied.world, AAL)
    expect(a.holdLeg).not.toBeNull()
    expect(a.holdShortLeg).toBe(a.holdLeg)
    expect(edgeName(world.graph, a.path![a.holdLeg!]!, a.path![a.holdLeg! + 1]!)).toBe('B')
    expect(refusal(taxied.world, `${AAL} HS ZZ`)).toBe('ZZ is not on the route')
    expect(refusal(world, `${AAL} RWY 30L TAXI D HS ZZ`)).toBe('ZZ is not on the route')
    const short = runUntil(taxied.world, stateOf(AAL, 'SHORT'), 600)
    expect(pilotLines(short.events)).toContain(`${AAL}: holding short of B`)
    const resumed = command(short.world, `${AAL} RES`)
    expect(pilotLines(resumed.events)).toEqual([`${AAL}: crossing B`])
    const r = aircraftNamed(resumed.world, AAL)
    expect(r.state).toBe('TAXI')
    expect(r.holdShortLeg).toBeNull()
    expect(r.holdLeg).toBeNull()
    const done = runUntil(resumed.world, stateOf(AAL, 'SHORT'), 600)
    expect(pilotLines(done.events)).toContain(`${AAL}: holding short of 30L`)
  })

  /** The route to 17 from the terminal crosses 4-22 on A and 12R-30L at A10, both through a shared node, never on a runway edge. */
  test('a taxi route holds short of every runway it crosses until CROSS, one at a time', () => {
    const world = groundWorld()
    const graph = world.graph
    const taxied = command(world, `${AAL} RWY 17`)
    const a = aircraftNamed(taxied.world, AAL)
    const entered = a.path!.slice(0, -1).flatMap((n, i) => runwaysEntered(graph, n, a.path![i + 1]!))
    expect(entered).toEqual(['4-22', '12R-30L'])
    expect(a.path!.slice(0, -1).some((n, i) => isRunwayName(graph, edgeName(graph, n, a.path![i + 1]!) ?? ''))).toBe(false)
    expect(a.holdLeg).not.toBeNull()
    expect(runwaysEntered(graph, a.path![a.holdLeg!]!, a.path![a.holdLeg! + 1]!)).toEqual(['4-22'])
    const taxiing = run(taxied.world, 20)
    expect(refusal(taxiing.world, `${AAL} RES`)).toBe('already moving')
    const first = runUntil(taxiing.world, stateOf(AAL, 'SHORT'), 600)
    expect(pilotLines(first.events)).toContain(`${AAL}: holding short of 4-22`)
    const f = aircraftNamed(first.world, AAL)
    expect(f.leg).toBe(f.holdLeg!)
    expect(graph.nodeRunways[f.path![f.leg]!]).toEqual([])
    expect(refusal(first.world, `${AAL} CROSS 99`)).toBe('no runway 99')
    const crossed = command(first.world, `${AAL} CROSS 4`)
    expect(pilotLines(crossed.events)).toEqual([`${AAL}: crossing 4`])
    const c = aircraftNamed(crossed.world, AAL)
    expect(c.state).toBe('TAXI')
    expect(c.cleared).toEqual(['4-22'])
    expect(runwaysEntered(graph, c.path![c.holdLeg!]!, c.path![c.holdLeg! + 1]!)).toEqual(['12R-30L'])
    const second = runUntil(run(crossed.world, 5).world, stateOf(AAL, 'SHORT'), 600)
    expect(pilotLines(second.events)).toContain(`${AAL}: holding short of 12R-30L`)
    const again = command(second.world, `${AAL} CROSS`)
    expect(pilotLines(again.events)).toEqual([`${AAL}: crossing 12R-30L`])
    expect(aircraftNamed(again.world, AAL).holdLeg).toBeNull()
    const done = runUntil(run(again.world, 5).world, stateOf(AAL, 'SHORT'), 900)
    expect(pilotLines(done.events)).toContain(`${AAL}: holding short of 17`)
    expect(aircraftNamed(done.world, AAL).path![aircraftNamed(done.world, AAL).leg]).toBe(holdNodeFor(graph, '17')!)
  })

  test('CROSS clauses in a taxi clearance clear those runways up front', () => {
    const world = groundWorld()
    const taxied = command(world, `${AAL} RWY 17 TAXI A CROSS 4 12R`)
    expect(pilotLines(taxied.events)).toEqual([`${AAL}: runway 17, taxi via D C A A10 W10 W, cross runway 4, cross runway 12R`])
    const a = aircraftNamed(taxied.world, AAL)
    expect(a.cleared).toEqual(['4-22', '12R-30L'])
    expect(a.holdLeg).toBeNull()
    const done = runUntil(taxied.world, stateOf(AAL, 'SHORT'), 1200)
    expect(pilotLines(done.events).filter((l) => l.includes('holding short'))).toEqual([`${AAL}: holding short of 17`])
    expect(refusal(world, `${AAL} RWY 17 CROSS 99`)).toBe('no runway 99')
    const one = command(world, `${AAL} TAXI A W10 CROSS 4 HS 12R`)
    expect(pilotLines(one.events)).toEqual([`${AAL}: hold short of 12R`, `${AAL}: taxi via D C A A10 W10, cross runway 4`])
    const o = aircraftNamed(one.world, AAL)
    expect(o.cleared).toEqual(['4-22'])
    expect(runwaysEntered(world.graph, o.path![o.holdLeg!]!, o.path![o.holdLeg! + 1]!)).toEqual(['12R-30L'])
  })

  test('a hold-short point beyond a runway crossing survives the crossing', () => {
    const world = groundWorld()
    const taxied = command(world, `${AAL} RWY 17 HS W10`)
    const a = aircraftNamed(taxied.world, AAL)
    expect(a.holdShortLeg).toBeGreaterThan(a.holdLeg!)
    const first = runUntil(taxied.world, stateOf(AAL, 'SHORT'), 600)
    expect(pilotLines(first.events)).toContain(`${AAL}: holding short of 4-22`)
    const crossed = command(first.world, `${AAL} CROSS 4`)
    const c = aircraftNamed(crossed.world, AAL)
    expect(c.holdShortLeg).toBe(a.holdShortLeg)
    const second = runUntil(run(crossed.world, 5).world, stateOf(AAL, 'SHORT'), 600)
    expect(pilotLines(second.events)).toContain(`${AAL}: holding short of 12R-30L`)
    const again = command(second.world, `${AAL} CROSS 12R`)
    expect(aircraftNamed(again.world, AAL).holdLeg).toBe(a.holdShortLeg)
    const third = runUntil(run(again.world, 5).world, stateOf(AAL, 'SHORT'), 600)
    expect(pilotLines(third.events)).toContain(`${AAL}: holding short of W10`)
    const resumed = command(third.world, `${AAL} RES`)
    expect(pilotLines(resumed.events)).toEqual([`${AAL}: crossing W10`])
    const done = runUntil(run(resumed.world, 5).world, stateOf(AAL, 'SHORT'), 900)
    expect(pilotLines(done.events)).toContain(`${AAL}: holding short of 17`)
  })

  test('CROSS for a runway further along pre-clears it without releasing the current hold', () => {
    const world = groundWorld()
    const first = runUntil(command(world, `${AAL} RWY 17`).world, stateOf(AAL, 'SHORT'), 600)
    const ahead = command(first.world, `${AAL} CROSS 12R`)
    expect(pilotLines(ahead.events)).toEqual([`${AAL}: crossing 12R`])
    const a = aircraftNamed(ahead.world, AAL)
    expect(a.state).toBe('SHORT')
    expect(a.cleared).toEqual(['12R-30L'])
    expect(runwaysEntered(world.graph, a.path![a.holdLeg!]!, a.path![a.holdLeg! + 1]!)).toEqual(['4-22'])
    const crossed = command(ahead.world, `${AAL} CROSS`)
    expect(pilotLines(crossed.events)).toEqual([`${AAL}: crossing 4-22`])
    expect(aircraftNamed(crossed.world, AAL).holdLeg).toBeNull()
  })

  test('a route across a runway holds short of it until CROSS, then re-arms the next', () => {
    const world = groundWorld()
    const graph = world.graph
    const end = graph.runwayEnds['4']!
    const hold = holdNodeFor(graph, '4')!
    const exit = graph.adjacency[end.chain[1]!]!.find((e) => !isRunwayName(graph, e.name))!.to
    const nodes = [hold, end.chain[0]!, end.chain[1]!, exit]
    const staged = withPath(graph, { ...aircraftNamed(world, AAL), state: 'TAXI', gate: null, position: graph.nodes[hold]! }, nodes)
    expect(staged.holdLeg).toBe(0)
    const crossing = edgeName(graph, nodes[1]!, nodes[2]!)!
    expect(isRunwayName(graph, crossing)).toBe(true)
    expect(runwaysEntered(graph, nodes[0]!, nodes[1]!)).toEqual([crossing])
    const w = { ...world, aircraft: world.aircraft.map((x) => (x.callsign === AAL ? staged : x)) }
    expect(refusal(w, `${AAL} CROSS`)).toBeNull()
    const short = runUntil(w, stateOf(AAL, 'SHORT'), 300)
    expect(pilotLines(short.events)).toContain(`${AAL}: holding short of ${crossing}`)
    expect(aircraftNamed(short.world, AAL).leg).toBe(0)
    const crossed = command(short.world, `${AAL} CROSS`)
    expect(pilotLines(crossed.events)).toEqual([`${AAL}: crossing ${crossing}`])
    const c = aircraftNamed(crossed.world, AAL)
    expect(c.state).toBe('TAXI')
    expect(c.cleared).toContain(crossing)
    expect(c.holdLeg).toBeNull()
    const done = runUntil(crossed.world, stateOf(AAL, 'HOLD'), 300)
    expect(pilotLines(done.events)).toContain(`${AAL}: holding`)
    expect(aircraftNamed(done.world, AAL).leg).toBe(3)
  })

  test('HOLD stops, RES continues, TAXIALL resumes every held aircraft', () => {
    const world = groundWorld()
    const taxied = run(command(world, `${AAL} RWY 30L`).world, 20)
    const held = command(taxied.world, `${AAL} HOLD`)
    expect(pilotLines(held.events)).toEqual([`${AAL}: holding`])
    const stopped = run(held.world, 5)
    expect(aircraftNamed(stopped.world, AAL).speed).toBe(0)
    expect(refusal(stopped.world, `${AAL} BREAK`)).toBeNull()
    const resumed = command(stopped.world, `${AAL} RES`)
    expect(pilotLines(resumed.events)).toEqual([`${AAL}: continuing`])
    expect(refusal(resumed.world, `${AAL} RES`)).toBe('already moving')
    const all = command(command(resumed.world, `${AAL} HOLD`).world, 'TAXIALL')
    expect(systemLines(all.events)).toEqual(['1 aircraft resumed'])
    expect(aircraftNamed(all.world, AAL).state).toBe('TAXI')
  })
})

describe('conflicts', () => {
  const setup = () => {
    const world = groundWorld()
    const taxied = command(world, `${AAL} RWY 30L`)
    const a = aircraftNamed(taxied.world, AAL)
    const ahead = { ...aircraftNamed(taxied.world, 'DAL2057'), state: 'HOLD' as const, position: world.graph.nodes[a.path![3]!]!, path: a.path!.slice(3), leg: 0, frac: 0, origin: null, gate: null }
    const staged = { ...taxied.world, aircraft: taxied.world.aircraft.map((x) => (x.callsign === 'DAL2057' ? ahead : x)) }
    return { world: staged, blocker: ahead }
  }

  test('an aircraft slows to 7 kt behind traffic and stops within 180 ft', () => {
    const { world, blocker } = setup()
    const approached = runUntil(world, (w) => aircraftNamed(w, AAL).blockedBy === 'DAL2057', 300)
    const settled = run(approached.world, 40)
    const a = aircraftNamed(settled.world, AAL)
    expect(a.speed).toBe(0)
    expect(a.state).toBe('TAXI')
    expect(distanceFt(world.graph.projection, a.position, blocker.position)).toBeLessThan(200)
    expect(distanceFt(world.graph.projection, a.position, blocker.position)).toBeGreaterThan(100)
  })

  test('BREAK ignores conflicts for 15 seconds', () => {
    const { world } = setup()
    const approached = runUntil(world, (w) => aircraftNamed(w, AAL).speed === 0 && aircraftNamed(w, AAL).blockedBy !== null, 300)
    const broke = command(approached.world, `${AAL} BREAK`)
    expect(pilotLines(broke.events)).toEqual([`${AAL}: coming through`])
    const moving = run(broke.world, 3)
    expect(aircraftNamed(moving.world, AAL).speed).toBeGreaterThan(5)
    expect(aircraftNamed(moving.world, AAL).blockedBy).toBeNull()
  })

  test('GIVEWAY waits for the named aircraft until it is 420 ft away', () => {
    const world = groundWorld()
    const taxied = command(world, `${AAL} RWY 30L`)
    const gave = command(taxied.world, `${AAL} GW DAL2057`)
    expect(pilotLines(gave.events)).toEqual([`${AAL}: giving way to DAL2057`])
    const other = aircraftNamed(world, 'DAL2057')
    expect(distanceFt(world.graph.projection, aircraftNamed(gave.world, AAL).position, other.position)).toBeGreaterThan(420)
    const after = run(gave.world, 1)
    expect(aircraftNamed(after.world, AAL).giveWayTo).toBeNull()
    expect(refusal(world, `${AAL} GW ZZZ999`)).toBe('no aircraft ZZZ999')
  })
})

describe('departure', () => {
  const holdingShort = () => {
    const world = groundWorld()
    return runUntil(command(world, `${AAL} RWY 30L`).world, stateOf(AAL, 'SHORT'), 900).world
  }

  test('LUAW lines up on the runway, CTO rolls and lifts off at Vr', () => {
    const world = holdingShort()
    expect(refusal(world, `${AAL} CTO`)).toBeNull()
    const lined = command(world, `${AAL} LUAW`)
    expect(pilotLines(lined.events)).toEqual([`${AAL}: line up and wait`])
    const luaw = runUntil(lined.world, stateOf(AAL, 'LUAW'), 120)
    expect(pilotLines(luaw.events)).toContain(`${AAL}: lined up runway 30L`)
    const threshold = world.graph.nodes[world.graph.runwayEnds['30L']!.chain[0]!]!
    expect(distanceFt(world.graph.projection, aircraftNamed(luaw.world, AAL).position, threshold)).toBeLessThan(2)
    const course = runwayCourse(world.graph, '30L')!
    expect(headingDiff(aircraftNamed(luaw.world, AAL).heading, course)).toBeGreaterThan(30)
    const aligned = run(luaw.world, 15)
    expect(headingDiff(aircraftNamed(aligned.world, AAL).heading, course)).toBeLessThan(0.01)
    expect(aircraftNamed(aligned.world, AAL).state).toBe('LUAW')
    const cleared = command(luaw.world, `${AAL} CTO`)
    expect(pilotLines(cleared.events)).toEqual([`${AAL}: cleared for takeoff runway 30L`])
    expect(aircraftNamed(cleared.world, AAL).state).toBe('TKOF')
    const airborne = runUntil(cleared.world, stateOf(AAL, 'AIRB'), 120)
    expect(systemLines(airborne.events)).toContain(`${AAL} airborne runway 30L, climbing 7000`)
    const a = aircraftNamed(airborne.world, AAL)
    expect(a.speed).toBeGreaterThanOrEqual(135)
    expect(a.transponder).toBe('N')
    expect(a.targetAltitude).toBe(7000)
    expect(airborne.seconds).toBeGreaterThan(20)
    expect(airborne.seconds).toBeLessThan(30)
  })

  test('CTO with a heading reads it back and turns out through 400 ft', () => {
    const world = holdingShort()
    const cleared = command(world, `${AAL} CTO L 250`)
    expect(pilotLines(cleared.events)).toEqual([`${AAL}: turn left heading 250, runway 30L, cleared for takeoff`])
    const c = aircraftNamed(cleared.world, AAL)
    expect(c.state).toBe('TKOF')
    expect(c.departureHeading).toBe(250)
    expect(c.departureTurn).toBe('L')
    const airborne = runUntil(cleared.world, stateOf(AAL, 'AIRB'), 120)
    const a = aircraftNamed(airborne.world, AAL)
    expect(headingDiff(a.targetHeading, a.heading)).toBeLessThan(1)
    expect(a.departureHeading).toBe(250)
    const turning = runUntil(airborne.world, (w) => aircraftNamed(w, AAL).targetHeading === 250, 120)
    const t = aircraftNamed(turning.world, AAL)
    expect(t.altitude).toBeGreaterThanOrEqual(world.airport.elevation + DEPARTURE_TURN_AGL_FT)
    expect(t.altitude).toBeLessThan(world.airport.elevation + DEPARTURE_TURN_AGL_FT + 50)
    expect(t.turn).toBe('L')
    expect(t.departureHeading).toBeNull()
    const done = runUntil(turning.world, (w) => headingDiff(aircraftNamed(w, AAL).heading, 250) < 0.01, 120)
    expect(aircraftNamed(done.world, AAL).turn).toBeNull()
    expect(pilotLines(command(holdingShort(), `${AAL} CTO 270`).events)).toEqual([`${AAL}: fly heading 270, runway 30L, cleared for takeoff`])
    expect(pilotLines(command(holdingShort(), `${AAL} CTO R 090`).events)).toEqual([`${AAL}: turn right heading 090, runway 30L, cleared for takeoff`])
    expect(refusal(holdingShort(), `${AAL} CTO L`)).toBe('heading?')
  })

  test('a heading given after takeoff replaces the one from the clearance', () => {
    const world = holdingShort()
    const airborne = runUntil(command(world, `${AAL} CTO R 090`).world, stateOf(AAL, 'AIRB'), 120).world
    const vectored = command(airborne, `${AAL} TL 210`)
    const v = aircraftNamed(vectored.world, AAL)
    expect(v.departureHeading).toBeNull()
    expect(v.targetHeading).toBe(210)
    const later = run(vectored.world, 90)
    expect(aircraftNamed(later.world, AAL).targetHeading).toBe(210)
  })

  test('the tower flight model climbs, turns and levels off', () => {
    const world = holdingShort()
    const airborne = runUntil(command(world, `${AAL} CTO`).world, stateOf(AAL, 'AIRB'), 120).world
    const climbed = run(airborne, 60)
    const a = aircraftNamed(climbed.world, AAL)
    expect(a.altitude).toBeCloseTo(2500, -1)
    expect(a.speed).toBeCloseTo(250, 0)
    const turned = command(climbed.world, `${AAL} TR 90`)
    expect(pilotLines(turned.events)).toEqual([`${AAL}: turn right heading 090`])
    const heading = (w: typeof world) => aircraftNamed(w, AAL).heading
    const start = heading(turned.world)
    const later = run(turned.world, 10)
    expect(headingDiff(start, heading(later.world))).toBeCloseTo(30, 0)
    const done = runUntil(later.world, (w) => headingDiff(heading(w), 90) < 0.01, 120)
    expect(aircraftNamed(done.world, AAL).turn).toBeNull()
    const descend = command(done.world, `${AAL} CM 20`)
    expect(pilotLines(descend.events)).toEqual([`${AAL}: descend and maintain two thousand`])
    const lower = run(descend.world, 60)
    expect(aircraftNamed(lower.world, AAL).altitude).toBeLessThan(aircraftNamed(descend.world, AAL).altitude)
    expect(refusal(groundWorld(), `${AAL} FH 90`)).toBe('not airborne')
    expect(refusal(groundWorld(), `${AAL} CM 50`)).toBe('not airborne')
    expect(refusal(groundWorld(), `${AAL} CD`)).toBe('not airborne')
  })

  test('CD hands off to departure and the aircraft drops off 20 s later', () => {
    const world = holdingShort()
    const airborne = runUntil(command(world, `${AAL} CTO`).world, stateOf(AAL, 'AIRB'), 120).world
    const handed = command(airborne, `${AAL} CD`)
    expect(pilotLines(handed.events)).toEqual([`${AAL}: over to Minneapolis Departure 124.700`])
    expect(refusal(handed.world, `${AAL} CD`)).toBe('already switched')
    const gone = run(handed.world, 21)
    expect(findAircraft(gone.world, AAL)).toBeUndefined()
    expect(systemLines(gone.events)).toContain(`${AAL} with Minneapolis Departure`)
  })

  test('an aircraft that flies 16 nm out leaves the area', () => {
    const world = holdingShort()
    const airborne = runUntil(command(world, `${AAL} CTO`).world, stateOf(AAL, 'AIRB'), 120).world
    const gone = runUntil(airborne, (w) => findAircraft(w, AAL) === undefined, 900)
    expect(systemLines(gone.events)).toContain(`${AAL} left the area without a frequency change`)
  })

  test('radar returns appear once a second with a five-point trail', () => {
    const world = holdingShort()
    expect(aircraftNamed(world, AAL).radar).toBeNull()
    expect(refusal(world, `${AAL} TRACK`)).toBe('no radar target')
    const airborne = run(runUntil(command(world, `${AAL} CTO`).world, stateOf(AAL, 'AIRB'), 120).world, 10)
    const a = aircraftNamed(airborne.world, AAL)
    expect(a.radar).not.toBeNull()
    expect(a.radar!.history).toHaveLength(5)
    const tracked = command(airborne.world, `${AAL} TRACK`)
    expect(aircraftNamed(tracked.world, AAL).tracked).toBe(true)
    expect(systemLines(tracked.events)).toEqual([`${AAL} tracked`])
    const dropped = command(tracked.world, `${AAL} DT`)
    expect(aircraftNamed(dropped.world, AAL).tracked).toBe(false)
  })

  test('props rotate at 65 and climb at 1000 fpm to the prop altitude', () => {
    expect(isProp('C172')).toBe(true)
    expect(isProp('PC12')).toBe(true)
    expect(isProp('B738')).toBe(false)
    expect(performance('C172', msp.init)).toMatchObject({ prop: true, vr: 65, climbSpeed: 140, verticalSpeed: 1000, initialAltitude: 5000 })
    expect(performance('B738', msp.init)).toMatchObject({ prop: false, vr: 135, climbSpeed: 250, verticalSpeed: 2500, initialAltitude: 7000 })
  })
})

describe('arrivals', () => {
  test('Ground: arrivals appear at 3 nm every 70 to 110 s on a generator runway and park on arrival', () => {
    const world = { ...groundWorld(), arrivalsEnabled: true }
    const spawned = runUntil(world, (w) => w.aircraft.some((a) => a.state === 'FINAL'), 1)
    const arrival = spawned.world.aircraft.find((a) => a.state === 'FINAL')!
    expect(arrival.runway).toBe('12R')
    expect(arrival.altitude).toBeCloseTo(3 * 318, 3)
    expect(arrival.clearedToLand).toBe(true)
    expect(arrival.tracked).toBe(true)
    expect(arrival.destinationGate).not.toBeNull()
    expect(systemLines(spawned.events)[0]).toBe(`${arrival.callsign} ${arrival.type} on final runway 12R, parking ${arrival.destinationGate}`)
    expect(spawned.world.nextArrivalAt).toBeGreaterThanOrEqual(70)
    expect(spawned.world.nextArrivalAt).toBeLessThan(110)
    const second = runUntil(spawned.world, (w) => w.aircraft.filter((a) => a.destination === 'MSP').length >= 2, 111)
    expect(second.seconds).toBeGreaterThanOrEqual(70)
    const landed = runUntil(spawned.world, (w) => findAircraft(w, arrival.callsign)?.landed === true, 200)
    expect(aircraftNamed(landed.world, arrival.callsign).altitude).toBe(0)
    const exited = runUntil(landed.world, (w) => findAircraft(w, arrival.callsign)?.state === 'TAXI', 200)
    expect(pilotLines(exited.events).some((l) => l.startsWith(`${arrival.callsign}: clear of the runway`))).toBe(true)
    const parked = runUntil(exited.world, (w) => findAircraft(w, arrival.callsign)?.state === 'PARKED', 1500)
    expect(pilotLines(parked.events)).toContain(`${arrival.callsign}: in the blocks at ${arrival.destinationGate}`)
    expect(aircraftNamed(parked.world, arrival.callsign).gate).toBe(arrival.destinationGate)
  })

  test('Local: arrivals appear at 6 nm, check in, and go around at 1 nm without CTL', () => {
    const world = { ...emptyWorld(LOCAL_RULES), arrivalsEnabled: true }
    const spawned = runUntil(world, (w) => w.aircraft.length > 0, 1)
    const arrival = spawned.world.aircraft[0]!
    expect(arrival.altitude).toBeCloseTo(6 * 318, 3)
    expect(arrival.clearedToLand).toBe(false)
    expect(pilotLines(spawned.events)[0]).toMatch(new RegExp(`^${arrival.callsign}: Minneapolis Tower, ${arrival.callsign}, six mile final, runway `))
    const around = runUntil(spawned.world, (w) => findAircraft(w, arrival.callsign)?.state === 'AIRB', 400)
    expect(pilotLines(around.events)).toContain(`${arrival.callsign}: going around, no landing clearance`)
    const a = aircraftNamed(around.world, arrival.callsign)
    expect(a.targetAltitude).toBe(3300)
    expect(a.targetSpeed).toBe(160)
    expect(a.goingAround).toBe(true)
    expect(refusal(around.world, `${arrival.callsign} CTL`)).toBe('not on final')
  })

  test('Local: CTL lets the arrival land; GA sends it around on request', () => {
    const world = { ...emptyWorld(LOCAL_RULES), arrivalsEnabled: true }
    const spawned = runUntil(world, (w) => w.aircraft.length > 0, 1)
    const cs = spawned.world.aircraft[0]!.callsign
    const cleared = command(spawned.world, `${cs} CTL`)
    expect(pilotLines(cleared.events)).toEqual([`${cs}: cleared to land runway ${spawned.world.aircraft[0]!.runway}`])
    const landed = runUntil(cleared.world, (w) => findAircraft(w, cs)?.landed === true, 400)
    expect(aircraftNamed(landed.world, cs).state).toBe('FINAL')
    expect(refusal(landed.world, `${cs} GA`)).toBe('not on final')
    const sent = command(spawned.world, `${cs} GA`)
    expect(pilotLines(sent.events)).toEqual([`${cs}: going around`])
    expect(aircraftNamed(sent.world, cs).state).toBe('AIRB')
  })

  test('an arrival taxiing to its gate holds short of the runways it must cross', () => {
    const world = groundWorld()
    const graph = world.graph
    const end = graph.runwayEnds['4']!
    const mid = Math.floor(end.chain.length / 2)
    const rolling = {
      ...aircraftNamed(world, 'AAL894'),
      state: 'ROLLOUT' as const,
      runway: '4',
      destinationGate: 'H1',
      gate: null,
      position: graph.nodes[end.chain[mid]!]!,
      path: end.chain,
      leg: mid,
      frac: 0,
      origin: null,
      speed: 19,
    }
    const out = autoExit(world, rolling)
    const a = out.aircraft!
    expect(a.state).toBe('TAXI')
    expect(a.cleared).toEqual(['4-22'])
    expect(a.holdLeg).not.toBeNull()
    expect(runwaysEntered(graph, a.path![a.holdLeg!]!, a.path![a.holdLeg! + 1]!)).toEqual(['12R-30L'])
    const w = { ...world, aircraft: world.aircraft.map((x) => (x.callsign === 'AAL894' ? a : x)) }
    const short = runUntil(w, stateOf('AAL894', 'SHORT'), 900)
    expect(pilotLines(short.events)).toContain('AAL894: holding short of 12R-30L')
    const crossed = command(short.world, 'AAL894 CROSS 30L')
    expect(pilotLines(crossed.events)).toEqual(['AAL894: crossing 30L'])
    const parked = runUntil(crossed.world, stateOf('AAL894', 'PARKED'), 1200)
    expect(pilotLines(parked.events)).toContain('AAL894: in the blocks at H1')
  })

  test('arrivals only generate while enabled', () => {
    const quiet = run(groundWorld(), 200)
    expect(quiet.world.aircraft.every((a) => a.state === 'PARKED')).toBe(true)
  })
})

describe('transponder, say, delete, global', () => {
  test('squawk commands', () => {
    const world = groundWorld()
    const sq = command(world, `${AAL} SQ 4521`)
    expect(pilotLines(sq.events)).toEqual([`${AAL}: squawking 4521`])
    expect(aircraftNamed(sq.world, AAL)).toMatchObject({ squawk: '4521', transponder: 'N' })
    expect(aircraftNamed(command(sq.world, `${AAL} SS`).world, AAL).transponder).toBe('S')
    expect(aircraftNamed(command(sq.world, `${AAL} SN`).world, AAL).transponder).toBe('N')
    const ident = command(sq.world, `${AAL} ID`)
    expect(aircraftNamed(ident.world, AAL).transponder).toBe('I')
    expect(aircraftNamed(run(ident.world, 3.9).world, AAL).transponder).toBe('I')
    expect(aircraftNamed(run(ident.world, 4.1).world, AAL).transponder).toBe('N')
  })

  test('SAY answers', () => {
    const world = groundWorld()
    expect(pilotLines(command(world, `${AAL} SAY GATE`).events)).toEqual([`${AAL}: we're at E16`])
    expect(pilotLines(command(world, `${AAL} SAY TYPE`).events)).toEqual([`${AAL}: we're a B738`])
    expect(pilotLines(command(world, `${AAL} SAY RWY`).events)).toEqual([`${AAL}: no runway assigned`])
    expect(pilotLines(command(world, `${AAL} SAY`).events)).toEqual([`${AAL}: B738 at E16, KMSP to KCLT`])
    const assigned = command(world, `${AAL} RWY 30L`).world
    expect(pilotLines(command(assigned, `${AAL} SAY RUNWAY`).events)).toEqual([`${AAL}: expecting runway 30L`])
  })

  test('DEL removes the aircraft; PAUSE and SIMRATE are app events', () => {
    const world = groundWorld()
    const deleted = command(world, `${AAL} DEL`)
    expect(findAircraft(deleted.world, AAL)).toBeUndefined()
    expect(systemLines(deleted.events)).toEqual([`${AAL} deleted`])
    expect(command(world, 'PAUSE').events).toEqual([{ _tag: 'SetRunning', running: false }])
    expect(command(world, 'UNPAUSE').events).toEqual([{ _tag: 'SetRunning', running: true }])
    expect(command(world, 'SIMRATE 4').events).toEqual([{ _tag: 'SetRate', rate: 4 }])
    expect(refusal(world, 'PUSH')).toBe('select an aircraft first')
  })
})

describe('determinism', () => {
  test('the same seed and inputs give the same world', () => {
    const play = () => {
      const world = { ...groundWorld(GROUND_RULES, 99), arrivalsEnabled: true }
      const a = run(command(world, `${AAL} RWY 30L`).world, 120)
      return run(command(a.world, 'DAL2057 PUSH').world, 120).world
    }
    expect(play()).toEqual(play())
  })
})
