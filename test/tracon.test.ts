/**
 * The Approach position (docs/REWRITE.md Phase 8): airborne scenario starts,
 * fix following, the approach clearance, handoffs and STAR arrivals.
 */
import { describe, expect, test } from 'bun:test'

import { finalCourse, finalOffsets } from '../src/domain/physics'
import { GROUND_RULES, TRACON_RULES } from '../src/domain/rules'
import { DEPARTURE_GAP_S, departureRunwayFor, loadScenario, runwayFromApproach, trimPassed } from '../src/domain/scenario'
import { findAircraft, makeWorld } from '../src/domain/world'
import { aircraftNamed, command, msp, pilotLines, refusal, run, runUntil, scenarioNamed, systemLines } from './helpers'

const APP = 'Ancient MSP APP North'
const UCA = 'UCA3893'

const traconWorld = (name = APP, seed = 1) => loadScenario(makeWorld(msp, TRACON_RULES, seed), scenarioNamed(name))

describe('airborne scenario starts', () => {
  test('Approach loads airborne aircraft with their altitude, speed, heading, route and expected runway', () => {
    const { world, events } = traconWorld()
    const a = aircraftNamed(world, UCA)
    expect(a.state).toBe('AIRB')
    expect(a.position).toEqual([-91.74174, 45.140323])
    expect(a.altitude).toBe(11000)
    expect(a.speed).toBe(280)
    expect(a.heading).toBe(260)
    expect(a.fixes).toEqual(['MUSCL', 'BAYKS', 'WOLVS'])
    expect(a.runway).toBe('30R')
    expect(a.tracked).toBe(true)
    expect(a.checkedIn).toBe(true)
    expect(systemLines(events)[0]).toBe(`${APP} — 0 surface aircraft, 27 airborne. Student position MSP_S_APP.`)
    expect(pilotLines(events)).toContain(`${UCA}: Minneapolis Approach, ${UCA}, one one thousand`)
  })

  test('a start at field elevation is a departure that rolls from the runway matching its heading, one per runway every two minutes', () => {
    const { world } = traconWorld()
    const rolling = world.aircraft.filter((a) => a.state === 'TKOF')
    expect(rolling.length).toBe(13)
    expect(rolling.every((a) => a.runway !== null && a.path !== null)).toBe(true)
    const on4 = rolling.filter((a) => a.runway === '4').map((a) => a.delay).sort((x, y) => x - y)
    expect(on4.slice(0, 3)).toEqual([0, DEPARTURE_GAP_S, 2 * DEPARTURE_GAP_S])
    expect(departureRunwayFor(world, 40)).toBe('4')
    expect(departureRunwayFor(world, 300)).toBe('30L')
  })

  test('a departure calls the departure position through 1,000 ft above the field', () => {
    const { world } = traconWorld()
    const first = world.aircraft.find((a) => a.state === 'TKOF' && a.delay === 0)!
    const out = runUntil(world, (w) => (findAircraft(w, first.callsign)?.altitude ?? 0) > 1900, 240)
    const said = pilotLines(out.events).filter((l) => l.startsWith(first.callsign))
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(new RegExp(`^${first.callsign}: Minneapolis Departure, ${first.callsign}, climbing one thousand [a-z ]*for seven thousand$`))
    expect(aircraftNamed(out.world, first.callsign).checkedIn).toBe(true)
  })

  test('a delayed airborne aircraft checks in when it comes on frequency', () => {
    const { world } = traconWorld('M98 12s North MSP 1900 4MINIT')
    const delayed = world.aircraft.find((a) => a.state === 'AIRB' && a.delay > 0)!
    const out = runUntil(world, (w) => (findAircraft(w, delayed.callsign)?.delay ?? 1) <= 0, delayed.delay + 1)
    expect(pilotLines(out.events).filter((l) => l.startsWith(delayed.callsign))).toHaveLength(1)
    expect(systemLines(out.events)).toContainEqual(expect.stringContaining(`${delayed.callsign} ${delayed.type} on frequency — `))
  })

  test('Ground and Local do not load airborne starts', () => {
    const { world, events } = loadScenario(makeWorld(msp, GROUND_RULES, 1), scenarioNamed(APP))
    expect(world.aircraft).toHaveLength(0)
    expect(systemLines(events)[0]).toBe(`${APP} — 0 surface aircraft, 27 airborne not loaded. Student position MSP_S_APP.`)
  })

  test('helpers: the expected runway from an approach name, and fixes behind the aircraft are dropped', () => {
    const { world } = traconWorld()
    expect(runwayFromApproach(world, 'I30L')).toBe('30L')
    expect(runwayFromApproach(world, 'ILS 12R')).toBe('12R')
    expect(runwayFromApproach(world, 'RNAV 99')).toBeNull()
    expect(runwayFromApproach(world, null)).toBeNull()
    // MUSCL is east of the aircraft; heading west it is behind, BAYKS ahead
    expect(trimPassed(world, ['MUSCL', 'BAYKS'], [-92.2, 45.0], 260)).toEqual(['BAYKS'])
    expect(trimPassed(world, ['MUSCL', 'BAYKS'], [-91.5, 45.0], 260)).toEqual(['MUSCL', 'BAYKS'])
  })
})

describe('flight along fixes', () => {
  test('the aircraft turns to each fix, sequences it inside the lead distance, then keeps its heading', () => {
    const { world } = traconWorld()
    const passed = runUntil(world, (w) => aircraftNamed(w, UCA).fixes[0] === 'BAYKS', 900)
    const a = aircraftNamed(passed.world, UCA)
    const muscl = world.nav.fixes['MUSCL']!
    expect(finalOffsets(passed.world, { threshold: muscl, course: 0 }, a.position).along).toBeLessThan(1)
    expect(a.altitude).toBe(11000)
    const done = runUntil(passed.world, (w) => aircraftNamed(w, UCA).fixes.length === 0, 1200)
    const b = aircraftNamed(done.world, UCA)
    expect(b.targetHeading).toBeCloseTo(b.heading, 0)
    expect(b.state).toBe('AIRB')
  })

  test('DCT skips ahead on the route or replaces it; an unknown fix is refused', () => {
    const { world } = traconWorld()
    const direct = command(world, `${UCA} DCT WOLVS`)
    expect(pilotLines(direct.events)).toEqual([`${UCA}: direct WOLVS`])
    expect(aircraftNamed(direct.world, UCA).fixes).toEqual(['WOLVS'])
    const elsewhere = command(world, `${UCA} DCT GEP`)
    expect(aircraftNamed(elsewhere.world, UCA).fixes).toEqual(['GEP'])
    expect(refusal(world, `${UCA} DCT NOWHERE`)).toBe('unfamiliar with NOWHERE')
    const parked = loadScenario(makeWorld(msp, GROUND_RULES, 1), scenarioNamed('KMSP 12s/17 SLCL 5MIT')).world
    expect(refusal(parked, 'AAL894 DCT GEP')).toBe('not airborne')
  })

  test('FH cancels the route and any approach clearance', () => {
    const { world } = traconWorld()
    const cleared = command(world, `${UCA} CAPP 30R`).world
    const vectored = command(cleared, `${UCA} FH 180`)
    const a = aircraftNamed(vectored.world, UCA)
    expect(a.fixes).toEqual([])
    expect(a.approach).toBeNull()
    expect(a.targetHeading).toBe(180)
  })

  test('DM descends, SPD assigns a speed and SPD alone resumes; below 10,000 the pilot holds 250', () => {
    const { world } = traconWorld()
    const down = command(world, `${UCA} DM 8000`)
    expect(pilotLines(down.events)).toEqual([`${UCA}: descend and maintain eight thousand`])
    const slowed = command(down.world, `${UCA} SPD 210`)
    expect(pilotLines(slowed.events)).toEqual([`${UCA}: reduce speed to 210`])
    const later = run(slowed.world, 240)
    const a = aircraftNamed(later.world, UCA)
    expect(a.altitude).toBe(8000)
    expect(a.speed).toBe(210)
    const resumed = command(later.world, `${UCA} SPD`)
    expect(pilotLines(resumed.events)).toEqual([`${UCA}: resume normal speed`])
    const settled = run(resumed.world, 60)
    expect(aircraftNamed(settled.world, UCA).speed).toBe(250)
    expect(refusal(world, `${UCA} SPD 50`)).toBe('speed?')
  })
})

describe('approach clearance', () => {
  /** UCA3893 descended and vectored to intercept the 30R final from the north-east. */
  const setUp = () => {
    const { world } = traconWorld()
    let w = command(world, `${UCA} DM 4000`).world
    w = command(w, `${UCA} SPD 210`).world
    w = runUntil(w, (x) => aircraftNamed(x, UCA).altitude <= 6000, 900).world
    w = command(w, `${UCA} FH 240`).world
    return w
  }

  test('EXP sets the expected runway; CAPP without one uses it; unknown runways are refused', () => {
    const { world } = traconWorld()
    const expected = command(world, `${UCA} EXP 12L`)
    expect(pilotLines(expected.events)).toEqual([`${UCA}: expect runway 12L`])
    const cleared = command(expected.world, `${UCA} CAPP`)
    expect(pilotLines(cleared.events)).toEqual([`${UCA}: cleared ILS runway 12L approach`])
    expect(aircraftNamed(cleared.world, UCA).approach).toBe('12L')
    expect(refusal(world, `${UCA} CAPP 99`)).toBe('no runway 99')
    expect(refusal(world, `${UCA} EXP 99`)).toBe('no runway 99')
  })

  test('cleared for the approach the aircraft joins the final course, descends on the 3° path, becomes a 10-mile final and is removed when it lands', () => {
    const before = setUp()
    const cleared = command(before, `${UCA} CAPP 30R`)
    expect(pilotLines(cleared.events)).toEqual([`${UCA}: cleared ILS runway 30R approach`])
    const joined = runUntil(cleared.world, (w) => aircraftNamed(w, UCA).established, 1500)
    expect(systemLines(joined.events)).toContainEqual(expect.stringMatching(new RegExp(`^${UCA} established on the final approach course runway 30R, \\d+ miles$`)))
    const fc = finalCourse(joined.world.graph, '30R')!
    const at = aircraftNamed(joined.world, UCA)
    expect(Math.abs(finalOffsets(joined.world, fc, at.position).cross)).toBeLessThan(1.3)
    expect(at.fixes).toEqual([])
    const onFinal = runUntil(joined.world, (w) => findAircraft(w, UCA)?.state === 'FINAL', 900)
    const f = aircraftNamed(onFinal.world, UCA)
    expect(f.runway).toBe('30R')
    expect(f.clearedToLand).toBe(true)
    expect(f.speed).toBeLessThanOrEqual(170)
    expect(f.altitude).toBeLessThanOrEqual(10 * 318 + 100)
    expect(systemLines(onFinal.events)).toContainEqual(`${UCA} 10 mile final runway 30R`)
    const landed = runUntil(onFinal.world, (w) => findAircraft(w, UCA) === undefined, 900)
    expect(systemLines(landed.events)).toContain(`${UCA} landed runway 30R`)
  })

  test('an aircraft not pointed at the course keeps flying its heading until it is', () => {
    const before = setUp()
    const away = command(before, `${UCA} FH 060`).world
    const cleared = command(away, `${UCA} CAPP 30R`).world
    const later = run(cleared, 120)
    expect(aircraftNamed(later.world, UCA).established).toBe(false)
  })

  test('CT hands the arrival to the tower and it stays on the scope until it lands; CD sends a departure to the centre', () => {
    const before = setUp()
    const cleared = command(before, `${UCA} CAPP 30R`).world
    const switched = command(cleared, `${UCA} CT`)
    expect(pilotLines(switched.events)).toEqual([`${UCA}: over to Minneapolis Tower 126.700`])
    expect(refusal(switched.world, `${UCA} CT`)).toBe('already switched')
    const later = run(switched.world, 60)
    expect(findAircraft(later.world, UCA)?.handoffTo).toBe('tower')
    const landed = runUntil(later.world, (w) => findAircraft(w, UCA) === undefined, 1800)
    expect(systemLines(landed.events)).toContain(`${UCA} landed runway 30R`)

    const { world } = traconWorld()
    const departure = world.aircraft.find((a) => a.state === 'TKOF' && a.delay === 0)!
    const airborne = runUntil(world, (w) => findAircraft(w, departure.callsign)?.state === 'AIRB', 120).world
    const centre = command(airborne, `${departure.callsign} CD`)
    expect(pilotLines(centre.events)).toEqual([`${departure.callsign}: over to Minneapolis Center 125.300`])
    const gone = run(centre.world, 21)
    expect(findAircraft(gone.world, departure.callsign)).toBeUndefined()
    expect(systemLines(gone.events)).toContain(`${departure.callsign} with Minneapolis Center`)
  })

  test('aircraft 150 nm out leave the area; the 16 nm Local limit is unchanged', () => {
    const { world } = traconWorld()
    const far = command(world, `${UCA} FH 090`).world
    const out = runUntil(far, (w) => findAircraft(w, UCA) === undefined, 3600)
    expect(systemLines(out.events)).toContain(`${UCA} left the area without a frequency change`)
    expect(out.seconds).toBeGreaterThan(1000)
  })
})

describe('STAR arrivals', () => {
  test('with the generator on, arrivals appear at the entry of a STAR at 11,000 and 280, on a route, checking in', () => {
    const { world } = loadScenario(makeWorld(msp, TRACON_RULES, 3), null)
    const on = { ...world, arrivalsEnabled: true, nextArrivalAt: 5 }
    const spawned = runUntil(on, (w) => w.aircraft.length > 0, 10)
    const a = spawned.world.aircraft[0]!
    expect(a.state).toBe('AIRB')
    expect(a.altitude).toBe(11000)
    expect(a.speed).toBe(280)
    expect(a.fixes.length).toBeGreaterThan(0)
    expect(a.flightPlan.star).toMatch(/^[A-Z]{3,5}\d$/)
    expect(a.runway).not.toBeNull()
    expect(a.tracked).toBe(true)
    expect(systemLines(spawned.events)).toContainEqual(expect.stringMatching(new RegExp(`^${a.callsign} ${a.type} on the ${a.flightPlan.star} at [A-Z0-9]+, expecting runway ${a.runway}$`)))
    expect(pilotLines(spawned.events)).toContainEqual(`${a.callsign}: Minneapolis Approach, ${a.callsign}, one one thousand`)
    const flown = run(spawned.world, 60)
    expect(aircraftNamed(flown.world, a.callsign).fixes.length).toBeLessThanOrEqual(a.fixes.length)
  })

  test('without nav data the generator falls back to finals', () => {
    const bare = { ...makeWorld(msp, TRACON_RULES, 3), nav: { fixes: {}, stars: {}, sids: {} }, arrivalsEnabled: true, nextArrivalAt: 5 }
    const spawned = runUntil(bare, (w) => w.aircraft.length > 0, 10)
    expect(spawned.world.aircraft[0]!.state).toBe('FINAL')
  })
})
