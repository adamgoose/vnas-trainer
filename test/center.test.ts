/**
 * The Center position (docs/REWRITE.md Phase 9): the ARTCC file, the World made
 * with it, ERAM message syntax (flight id last), the flight plan entries, sector
 * handoffs, CA, and the ERAM pane.
 */
import { describe, expect, test } from 'bun:test'

import { DisplayCommand, executeCommand, flightPlanReadout, isEramEntry, parseCommandLine } from '../src/domain/commands'
import { HANDOFF_ACCEPT_S } from '../src/domain/aircraft'
import { expandNavigationPath, mergeNav, navForArtcc, decodeNavData } from '../src/domain/navdata'
import { CENTER_RULES, TRACON_RULES } from '../src/domain/rules'
import { loadScenario } from '../src/domain/scenario'
import { assembleArtcc, sectorId } from '../src/domain/vnas'
import { checkInRadioName, findAircraft, makeWorld, nextFacility, withArtcc } from '../src/domain/world'
import { EramMessage, EramOut, applyDisplay, defaultFilters, eramInit, eramUpdate, initialEram, initialGeoMap, mapsToShow, routesShown } from '../src/positions/center/eram'
import { altitudeLine, fdbLines, fieldE, ldbLines } from '../src/view/eram'
import { AtcCommand, aircraftNamed, command, msp, pilotLines, refusal, run, runUntil, scenarioNamed, systemLines, zmp } from './helpers'

const APP = 'Ancient MSP APP North'
const UCA = 'UCA3893'

const centerWorld = (name = APP, seed = 1) => loadScenario(makeWorld(msp, CENTER_RULES, seed, zmp), scenarioNamed(name))

describe('the ARTCC file', () => {
  test('ZMP carries its GeoMaps with filters and BCGs, its sectors and centre positions, and the en-route nav', () => {
    expect(zmp.id).toBe('ZMP')
    expect(zmp.geoMaps.length).toBeGreaterThanOrEqual(8)
    const control = zmp.geoMaps[0]!
    expect(control.name).toBe('CONTROL')
    expect(control.label).toEqual(['MAIN', 'MAP'])
    expect(control.filters[0]).toEqual(['HIGH', 'SECTORS'])
    expect(control.bcg[0]).toBe('HI SEC')
    expect(control.maps.length).toBeGreaterThan(50)
    expect(control.maps.some((m) => m.tdm)).toBe(true)
    expect(zmp.sectors).toContain('06')
    expect(zmp.positions.find((p) => p.sector === '11')).toMatchObject({ cs: 'MSP_11_CTR', radio: 'Minneapolis Center', freq: '133.400' })
    expect(Object.keys(zmp.nav.fixes).length).toBeGreaterThan(5000)
    expect(zmp.nav.airways?.['J34']).toBeDefined()
    expect(zmp.rangeNm).toBeGreaterThan(300)
  })

  test('assembleArtcc reads the ERAM configuration; sector ids are two characters', () => {
    const file = assembleArtcc({
      id: 'ZXX',
      name: 'Test ARTCC',
      document: {
        facility: {
          id: 'ZXX',
          eramConfiguration: {
            nasId: 'X',
            sectors: [{ sectorId: 5 }, { sectorId: '12' }, { sectorId: 5 }],
            geoMaps: [{ id: 'g1', name: 'MAIN', labelLine1: 'MAIN', labelLine2: 'MAP', filterMenu: [{ labelLine1: 'HIGH', labelLine2: 'SCTRS' }, { labelLine1: '', labelLine2: '' }], bcgMenu: ['HI SEC'], videoMapIds: ['m1', 'm2', 'missing'] }],
          },
          positions: [{ id: 'p1', callsign: 'XXX_05_CTR', name: '05 LO', radioName: 'Test Center', frequency: 125300000, eramConfiguration: { sectorId: '5' } }, { id: 'p2', callsign: 'XXX_TWR' }],
        },
        videoMaps: [{ id: 'm1', name: 'a', tdmOnly: false }, { id: 'm2', name: 'b', tdmOnly: true }],
      },
      nav: null,
    })
    expect(file.nasId).toBe('X')
    expect(file.sectors).toEqual(['05', '12'])
    expect(file.positions).toEqual([{ sector: '05', cs: 'XXX_05_CTR', name: '05 LO', radio: 'Test Center', freq: '125.300' }])
    expect(file.geoMaps[0]).toMatchObject({ id: 'g1', label: ['MAIN', 'MAP'], filters: [['HIGH', 'SCTRS'], ['', '']], bcg: ['HI SEC'], maps: [{ id: 'm1', tdm: false }, { id: 'm2', tdm: true }] })
    expect(sectorId(5)).toBe('05')
    expect(sectorId(null)).toBeNull()
    expect(assembleArtcc({ id: 'ZYY', name: 'Empty', document: null, nav: null }).geoMaps).toEqual([])
  })

  test('navForArtcc boxes the ARTCC around its airports and keeps the airways touching a fix inside', () => {
    const nav = decodeNavData(new Uint8Array(0))
    expect(navForArtcc(nav, 'ZMP')).toBeNull()
    const merged = mergeNav(msp.nav!, zmp.nav)
    expect(Object.keys(merged.fixes).length).toBeGreaterThan(Object.keys(msp.nav!.fixes).length)
    expect(merged.stars['MUSCL']).toBeDefined()
    expect(merged.airways?.['J34']).toEqual(zmp.nav.airways!['J34'])
  })

  test('an airway between two of its fixes on a route is expanded, in either direction', () => {
    const nav = { fixes: { A: [0, 0] as const, B: [1, 0] as const, C: [2, 0] as const, D: [3, 0] as const }, stars: {}, sids: {}, airways: { J1: ['A', 'B', 'C', 'D'] } }
    expect(expandNavigationPath(nav, 'A J1 D', [0, 0]).fixes).toEqual(['A', 'B', 'C', 'D'])
    expect(expandNavigationPath(nav, 'D J1 A', [3, 0]).fixes).toEqual(['D', 'C', 'B', 'A'])
    expect(expandNavigationPath(nav, 'A J1', [0, 0]).fixes).toEqual(['A'])
    expect(expandNavigationPath(nav, 'A J9 D', [0, 0]).fixes).toEqual(['A', 'D'])
  })
})

describe('the World as Center', () => {
  test('is made with the ARTCC nav and sectors; aircraft carry a CID and their filed altitude as the assigned altitude', () => {
    const { world, events } = centerWorld()
    expect(world.airport.sectors.length).toBeGreaterThan(40)
    expect(Object.keys(world.nav.fixes).length).toBeGreaterThan(5000)
    const a = aircraftNamed(world, UCA)
    expect(a.cid).toMatch(/^\d{3}$/)
    expect(a.assignedAltitude).toBe(a.flightPlan.cruiseAltitude)
    expect(new Set(world.aircraft.map((x) => x.cid)).size).toBeGreaterThan(20)
    expect(pilotLines(events)).toContain(`${UCA}: Minneapolis Center, ${UCA}, one one thousand`)
    expect(checkInRadioName(world, true)).toBe('Minneapolis Center')
    expect(checkInRadioName(makeWorld(msp, TRACON_RULES, 1), true)).toBe('Minneapolis Departure')
  })

  test('withArtcc merges an ARTCC file into a World made without one', () => {
    const bare = makeWorld(msp, CENTER_RULES, 1)
    expect(bare.airport.sectors).toEqual([])
    const merged = withArtcc(bare, zmp, msp.nav ?? null)
    expect(merged.airport.sectors.length).toBeGreaterThan(40)
    expect(merged.nav.stars['MUSCL']).toBeDefined()
    expect(merged.nav.airways?.['J34']).toBeDefined()
  })

  test('a departure calls the centre through 8,000 ft, not 1,000', () => {
    const { world } = centerWorld()
    const first = world.aircraft.find((a) => a.state === 'TKOF' && a.delay === 0)!
    const low = runUntil(world, (w) => (findAircraft(w, first.callsign)?.altitude ?? 0) > 3000, 300)
    expect(pilotLines(low.events).filter((l) => l.startsWith(first.callsign))).toHaveLength(0)
    const high = runUntil(low.world, (w) => (findAircraft(w, first.callsign)?.altitude ?? 0) > 9500, 600)
    expect(pilotLines(high.events).filter((l) => l.startsWith(first.callsign))[0]).toMatch(new RegExp(`^${first.callsign}: Minneapolis Center, ${first.callsign}, climbing`))
  })

  test('the arrival generator starts aircraft at FL330 on a STAR', () => {
    const { world } = centerWorld()
    const on = { ...world, arrivalsEnabled: true, nextArrivalAt: 0 }
    const spawned = runUntil(on, (w) => w.aircraft.length > world.aircraft.length, 5)
    const a = spawned.world.aircraft.find((x) => !world.aircraft.some((y) => y.callsign === x.callsign))!
    expect(a.altitude).toBe(33000)
    expect(a.assignedAltitude).toBe(33000)
    expect(a.speed).toBe(440)
    expect(pilotLines(spawned.events)).toContainEqual(`${a.callsign}: Minneapolis Center, ${a.callsign}, flight level three three zero`)
  })

  test('CA hands an arrival to the approach; CD goes to the sector a handoff was started to', () => {
    const { world } = centerWorld()
    const ca = command(world, `${UCA} CA`)
    expect(pilotLines(ca.events)).toEqual([`${UCA}: over to Minneapolis Approach ${world.airport.approach!.freq}`])
    expect(aircraftNamed(ca.world, UCA).handoffTo).toBe('approach')
    const gone = run(ca.world, 25)
    expect(findAircraft(gone.world, UCA)).toBeUndefined()
    expect(systemLines(gone.events)).toContain(`${UCA} with Minneapolis Approach`)
    expect(refusal(ca.world, `${UCA} CA`)).toBe('already switched')

    const handed = command(world, `11 ${UCA}`)
    expect(systemLines(handed.events)).toEqual([`${UCA} handoff to sector 11`])
    expect(nextFacility(handed.world, '11')).toEqual({ radio: 'Minneapolis Center', freq: '133.400' })
    const cd = command(handed.world, `${UCA} CD`)
    expect(pilotLines(cd.events)).toEqual([`${UCA}: over to Minneapolis Center 133.400`])
  })
})

describe('ERAM messages', () => {
  const { world } = centerWorld()

  test('the flight id comes last; without one the selected aircraft is used; unknown verbs are not ERAM lines', () => {
    const qz = parseCommandLine(world, null, `QZ 240 ${UCA}`)
    expect(qz).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.AssignAltitude({ altitude: 24000 }) })
    expect(parseCommandLine(world, UCA, 'QZ FL350')).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.AssignAltitude({ altitude: 35000 }) })
    expect(parseCommandLine(world, null, 'QZ 240')).toEqual({ _tag: 'Invalid', callsign: null, error: 'QZ needs a flight id' })
    expect(parseCommandLine(world, null, `qq 110 ${UCA}`)).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.InterimAltitude({ altitude: 11000 }) })
    expect(parseCommandLine(world, null, `QQ ${UCA}`)).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.InterimAltitude({ altitude: null }) })
    expect(parseCommandLine(world, null, `QS 270 ${UCA}`)).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.SetHsf({ heading: 270, speed: null, text: null, clear: 'none' }) })
    expect(parseCommandLine(world, null, `QS /250 ${UCA}`)).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.SetHsf({ heading: null, speed: 250, text: null, clear: 'none' }) })
    expect(parseCommandLine(world, null, `QS * ${UCA}`)).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.SetHsf({ heading: null, speed: null, text: null, clear: 'all' }) })
    expect(parseCommandLine(world, null, `QS WX DEV ${UCA}`)).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.SetHsf({ heading: null, speed: null, text: 'WX DEV', clear: 'none' }) })
    expect(parseCommandLine(world, null, `QS ${UCA}`)).toEqual({ _tag: 'Display', callsign: UCA, display: DisplayCommand.ToggleHsf() })
    expect(parseCommandLine(world, null, `QU MUSCL ${UCA}`)).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.AmendDirect({ fix: 'MUSCL' }) })
    expect(parseCommandLine(world, null, `QU 20 ${UCA}`)).toEqual({ _tag: 'Display', callsign: UCA, display: DisplayCommand.RouteDisplay({ minutes: 20 }) })
    expect(parseCommandLine(world, null, `QU ${UCA}`)).toEqual({ _tag: 'Display', callsign: UCA, display: DisplayCommand.RouteDisplay({ minutes: null }) })
    expect(parseCommandLine(world, null, 'QU')).toEqual({ _tag: 'Display', callsign: null, display: DisplayCommand.ClearRoutes() })
    expect(parseCommandLine(world, null, `QT ${UCA}`)).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.Track() })
    expect(parseCommandLine(world, null, `QX ${UCA}`)).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.Drop() })
    expect(parseCommandLine(world, null, `QF ${UCA}`)).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.FlightPlanReadout() })
    expect(parseCommandLine(world, null, `QB 4521 ${UCA}`)).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.Squawk({ code: '4521' }) })
    expect(parseCommandLine(world, null, `QB ${UCA}`)).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.RequestBeacon() })
    expect(parseCommandLine(world, null, `QP J ${UCA}`)).toEqual({ _tag: 'Display', callsign: UCA, display: DisplayCommand.ToggleHalo() })
    expect(parseCommandLine(world, null, `AM ${UCA} ALT 300`)).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.AssignAltitude({ altitude: 30000 }) })
    expect(parseCommandLine(world, null, `AM ${UCA} BCN 1301`)).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.Squawk({ code: '1301' }) })
    expect(parseCommandLine(world, null, `06 ${UCA}`)).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.HandoffSector({ sector: '06' }) })
    expect(parseCommandLine(world, null, `99 ${UCA}`)).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.HandoffSector({ sector: '99' }) })
    expect(parseCommandLine(world, null, 'MR')).toEqual({ _tag: 'Display', callsign: null, display: DisplayCommand.GeoMap({ name: null }) })
    expect(parseCommandLine(world, null, 'MR AREA1')).toEqual({ _tag: 'Display', callsign: null, display: DisplayCommand.GeoMap({ name: 'AREA1' }) })
    expect(parseCommandLine(world, null, 'QZ')).toEqual({ _tag: 'Invalid', callsign: null, error: 'QZ <altitude> <FLID>' })
    expect(parseCommandLine(world, null, 'cleared direct MUSCL')).toEqual({ _tag: 'Unknown' })
  })

  test('display entries: a bare flight id, positions, leader lengths and the VCI', () => {
    expect(parseCommandLine(world, null, UCA)).toEqual({ _tag: 'Display', callsign: UCA, display: DisplayCommand.ToggleBlock() })
    expect(parseCommandLine(world, null, `3 ${UCA}`)).toEqual({ _tag: 'Display', callsign: UCA, display: DisplayCommand.PositionBlock({ position: 3, leader: null }) })
    expect(parseCommandLine(world, null, `/2 ${UCA}`)).toEqual({ _tag: 'Display', callsign: UCA, display: DisplayCommand.PositionBlock({ position: null, leader: 2 }) })
    expect(parseCommandLine(world, null, `7/0 ${UCA}`)).toEqual({ _tag: 'Display', callsign: UCA, display: DisplayCommand.PositionBlock({ position: 7, leader: 0 }) })
    expect(parseCommandLine(world, null, `//${UCA}`)).toEqual({ _tag: 'Display', callsign: UCA, display: DisplayCommand.ToggleVci() })
    expect(parseCommandLine(world, null, `// ${UCA}`)).toEqual({ _tag: 'Display', callsign: UCA, display: DisplayCommand.ToggleVci() })
    // a callsign-first ATCTrainer line is untouched
    expect(parseCommandLine(world, null, `${UCA} DM 8000`)).toEqual({ _tag: 'Parsed', callsign: UCA, command: AtcCommand.ClimbMaintain({ altitude: 8000 }) })
    expect(isEramEntry(AtcCommand.AssignAltitude({ altitude: 1 }))).toBe(true)
    expect(isEramEntry(AtcCommand.ClimbMaintain({ altitude: 1 }))).toBe(false)
  })

  test('QZ, QQ and QS change the data block, not the pilot; QU amends the route; QF reads the plan back', () => {
    const qz = command(world, `QZ 240 ${UCA}`)
    expect(qz.events).toEqual([])
    const a = aircraftNamed(qz.world, UCA)
    expect(a.assignedAltitude).toBe(24000)
    expect(a.targetAltitude).toBe(11000)
    expect(altitudeLine({ ...a, radar: { position: a.position, altitude: 11000, speed: 280, history: [] } })).toBe('240-110')
    const qq = command(qz.world, `QQ 080 ${UCA}`)
    expect(aircraftNamed(qq.world, UCA).interimAltitude).toBe(8000)
    expect(altitudeLine({ ...aircraftNamed(qq.world, UCA), radar: { position: a.position, altitude: 11000, speed: 280, history: [] } })).toBe('080T110')
    expect(aircraftNamed(command(qq.world, `QQ ${UCA}`).world, UCA).interimAltitude).toBeNull()
    const qs = command(command(world, `QS 270 ${UCA}`).world, `QS /250 ${UCA}`)
    expect(aircraftNamed(qs.world, UCA).hsf).toEqual({ heading: 270, speed: 250, text: null })
    expect(aircraftNamed(command(qs.world, `QS */ ${UCA}`).world, UCA).hsf).toEqual({ heading: null, speed: 250, text: null })
    expect(aircraftNamed(command(qs.world, `QS * ${UCA}`).world, UCA).hsf).toEqual({ heading: null, speed: null, text: null })
    const qu = command(world, `QU BAYKS ${UCA}`)
    expect(aircraftNamed(qu.world, UCA).flightPlan.route!.startsWith('BAYKS')).toBe(true)
    expect(aircraftNamed(qu.world, UCA).fixes).toEqual(['MUSCL', 'BAYKS', 'WOLVS'])
    expect(refusal(world, `QU NOWHERE ${UCA}`)).toBe('unfamiliar with NOWHERE')
    const qf = command(world, `QF ${UCA}`)
    expect(systemLines(qf.events)[0]).toBe(flightPlanReadout(world, aircraftNamed(world, UCA)))
    expect(systemLines(qf.events)[0]).toMatch(new RegExp(`^0000 \\d{3} ${UCA}\\(--\\) `))
    const qb = command(world, `QB ${UCA}`)
    expect(aircraftNamed(qb.world, UCA).squawk).toMatch(/^[1-6]\d{3}$/)
    expect(qb.world.prng).not.toEqual(world.prng)
  })

  test('a sector handoff shows H then O in field E; a bare flight id recalls it before it is taken', () => {
    const handed = command(world, `06 ${UCA}`)
    const a = aircraftNamed(handed.world, UCA)
    expect(fieldE(handed.world, a)).toBe('H06')
    const later = run(handed.world, HANDOFF_ACCEPT_S + 1)
    expect(fieldE(later.world, aircraftNamed(later.world, UCA))).toBe('O06')
    expect(refusal(later.world, `QX ${UCA}`)).toBeNull()
    expect(refusal(handed.world, `05 ${UCA}`)).toBe('handoff to 06 already started')
    expect(refusal(later.world, `${UCA}`)).toBe('parse Display')
    const recalled = executeCommand(handed.world, UCA, AtcCommand.RecallHandoff())
    expect('error' in recalled ? recalled.error : systemLines(recalled.events)).toEqual([`${UCA} handoff recalled`])
    expect('error' in recalled ? null : aircraftNamed(recalled.world, UCA).handoffSector).toBeNull()
    const taken = executeCommand(later.world, UCA, AtcCommand.RecallHandoff())
    expect('error' in taken ? taken.error : null).toBe('sector 06 has the handoff')
    expect(refusal(world, `06 ${UCA}`)).toBeNull()
    expect(refusal(command(world, `QX ${UCA}`).world, `06 ${UCA}`)).toBe('not tracked')
    expect(fieldE(world, { ...a, handoffSector: null, squawk: '7700' })).toBe('EMRG')
    expect(fieldE(world, { ...a, handoffSector: null, radar: { position: a.position, altitude: 11000, speed: 285, history: [] } })).toBe('285')
  })

  test('data block lines', () => {
    const a = { ...aircraftNamed(world, UCA), radar: { position: [0, 0] as const, altitude: 24000, speed: 300, history: [] } }
    expect(altitudeLine({ ...a, assignedAltitude: 24000 })).toBe('240C')
    expect(altitudeLine({ ...a, assignedAltitude: 35000, targetAltitude: 35000 })).toBe('350↑240')
    expect(altitudeLine({ ...a, assignedAltitude: 35000, targetAltitude: 24000 })).toBe('350-240')
    expect(altitudeLine({ ...a, assignedAltitude: 11000, targetAltitude: 11000 })).toBe('110↓240')
    expect(altitudeLine({ ...a, assignedAltitude: 11000, targetAltitude: 24000 })).toBe('110+240')
    expect(altitudeLine({ ...a, assignedAltitude: null, flightPlan: { ...a.flightPlan, rules: 'V' } })).toBe('VFR/240')
    expect(fdbLines(world, { ...a, assignedAltitude: 24000, hsf: { heading: 270, speed: 250, text: null } }, { fdb: null, position: 5, leader: null, halo: false, vci: null, hsf: true })).toEqual([UCA, '240C', `${a.cid} 300`, 'H270 S250'])
    expect(fdbLines(world, { ...a, assignedAltitude: 24000 }, { fdb: null, position: 5, leader: null, halo: false, vci: null, hsf: true })[3]).toBe(a.destination ?? a.type)
    expect(ldbLines({ ...a, tracked: false })).toEqual([a.squawk, '240'])
    expect(ldbLines(a)).toEqual([UCA, '240'])
  })
})

describe('the ERAM pane', () => {
  test('opens on the remembered (else first) GeoMap with every filter on and its non-TDM maps loading', () => {
    const init = eramInit(initialEram, zmp)
    const control = zmp.geoMaps[0]!
    expect(init.model.geoMap).toBe(control.id)
    expect(init.model.filters).toEqual(defaultFilters(control))
    expect(init.model.filters.length).toBe(control.filters.filter((f) => f[0] !== '' || f[1] !== '').length)
    expect(init.commands?.length).toBe(mapsToShow(control, false).length)
    expect(mapsToShow(control, true).length).toBeGreaterThan(mapsToShow(control, false).length)
    const area1 = zmp.geoMaps[1]!
    const remembered = eramInit(initialEram, zmp, 150, { geoMap: area1.id, filters: [1, 2] })
    expect(remembered.model.geoMap).toBe(area1.id)
    expect(remembered.model.filters).toEqual([1, 2])
    expect(initialGeoMap(zmp, 'nope')?.id).toBe(control.id)
    expect(eramInit(initialEram, null).commands).toEqual([])
  })

  test('picking a GeoMap and toggling a filter report to the parent; TDM loads the diagrams', () => {
    const init = eramInit(initialEram, zmp).model
    const area1 = zmp.geoMaps[1]!
    const picked = eramUpdate(init, { message: EramMessage.PickedGeoMap({ id: area1.id }), world: null, artcc: zmp })
    expect(picked.model.geoMap).toBe(area1.id)
    expect(picked.outMessage).toEqual(EramOut.ChangedGeoMap({ geoMap: area1.id, filters: defaultFilters(area1) }))
    const toggled = eramUpdate(picked.model, { message: EramMessage.ToggledFilter({ index: 1 }), world: null, artcc: zmp })
    expect(toggled.model.filters).not.toContain(1)
    expect(toggled.outMessage).toEqual(EramOut.ChangedGeoMap({ geoMap: area1.id, filters: toggled.model.filters }))
    const tdm = eramUpdate(init, { message: EramMessage.ToggledTdm(), world: null, artcc: zmp })
    expect(tdm.model.tdm).toBe(true)
    expect(tdm.commands?.length).toBe(mapsToShow(zmp.geoMaps[0]!, true).length)
    // a right-click (the pane shares the STARS surface Mount) only drops the drag the press started
    const pressed = eramUpdate(init, { message: EramMessage.Pressed({ x: 10, y: 10 }), world: null, artcc: zmp }).model
    expect(pressed.drag).not.toBeNull()
    const context = eramUpdate(pressed, { message: EramMessage.Context({ x: 10, y: 10 }), world: null, artcc: zmp })
    expect(context.model.drag).toBeNull()
    expect(context.outMessage).toBeUndefined()
  })

  test('display entries change the block state, answer ACCEPT, and route displays expire', () => {
    const m = eramInit(initialEram, zmp).model
    const toggled = applyDisplay(m, zmp, UCA, DisplayCommand.ToggleBlock(), 0)
    expect(toggled.model.blocks[UCA]?.fdb).toBe(false)
    expect(toggled.model.feedback).toEqual({ ok: true, text: 'ACCEPT' })
    expect(toggled.outMessage).toEqual(EramOut.SelectedTarget({ callsign: UCA }))
    const placed = applyDisplay(toggled.model, zmp, UCA, DisplayCommand.PositionBlock({ position: 3, leader: 2 }), 0).model
    expect(placed.blocks[UCA]).toMatchObject({ position: 3, leader: 2 })
    expect(applyDisplay(placed, zmp, UCA, DisplayCommand.ToggleHalo(), 0).model.blocks[UCA]?.halo).toBe(true)
    expect(applyDisplay(placed, zmp, UCA, DisplayCommand.ToggleVci(), 0).model.blocks[UCA]?.vci).toBe(false)
    const routed = applyDisplay(placed, zmp, UCA, DisplayCommand.RouteDisplay({ minutes: 20 }), 100).model
    expect(routesShown(routed, 110)).toEqual([UCA])
    expect(routesShown(routed, 140)).toEqual([])
    expect(routesShown(applyDisplay(routed, zmp, UCA, DisplayCommand.RouteDisplay({ minutes: null }), 110).model, 111)).toEqual([])
    expect(routesShown(applyDisplay(routed, zmp, null, DisplayCommand.ClearRoutes(), 110).model, 111)).toEqual([])
    expect(applyDisplay(m, zmp, null, DisplayCommand.ToggleHalo(), 0).model.feedback).toEqual({ ok: false, text: 'FLID REQUIRED' })
    const listed = applyDisplay(m, zmp, null, DisplayCommand.GeoMap({ name: null }), 0).model
    expect(listed.response[0]).toBe('CONTROL MAIN MAP')
    const switched = applyDisplay(m, zmp, null, DisplayCommand.GeoMap({ name: 'AREA1' }), 0)
    expect(switched.model.geoMap).toBe(zmp.geoMaps[1]!.id)
    expect(applyDisplay(m, zmp, null, DisplayCommand.GeoMap({ name: 'NOPE' }), 0).model.feedback).toEqual({ ok: false, text: 'NO GEOMAP NOPE' })
  })
})
