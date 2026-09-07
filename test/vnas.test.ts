import { describe, expect, test } from 'bun:test'

import { aircraftType, assembleAirport, compactMap, compactScenario, departureProcedure, facilityIndex, formatFrequency, parseLenientJSON, scenarioForAirport, sidFromRoute, sidTransitionFromRoute, starFromRoute, starsForAirport } from '../src/domain/vnas'

describe('vNAS transforms', () => {
  test('lenient JSON repairs comment lines, leading zeros and trailing commas', () => {
    expect(parseLenientJSON('{"a": 1}')).toEqual({ a: 1 })
    expect(parseLenientJSON('// note\n{"heading": 010, "list": [1, 2,], }')).toEqual({ heading: 10, list: [1, 2] })
    expect(() => parseLenientJSON('nope')).toThrow()
  })

  test('aircraft type strips weight prefix and equipment suffix', () => {
    expect(aircraftType('H/B744/L')).toBe('B744')
    expect(aircraftType('B738/L')).toBe('B738')
    expect(aircraftType('C172')).toBe('C172')
    expect(aircraftType('')).toBe('')
    expect(aircraftType(null)).toBe('')
  })

  test('SID and STAR come from the first and last route tokens', () => {
    expect(sidFromRoute('ZMBRO7 ODI J30 JOT VHP J24 FLM TAFTT PARQR3')).toBe('ZMBRO7')
    expect(sidFromRoute('ZMBRO7.ODI J30')).toBe('ZMBRO7')
    expect(sidTransitionFromRoute('ZMBRO7 ODI J30 JOT VHP J24 FLM TAFTT PARQR3')).toBe('ODI')
    expect(sidTransitionFromRoute('ZMBRO7.ODI J30')).toBe('ODI')
    expect(sidTransitionFromRoute('COULT1 J34 BAE')).toBeNull()
    expect(sidTransitionFromRoute('ZMBRO7')).toBeNull()
    expect(sidTransitionFromRoute('GOLLF GEP5')).toBeNull()
    expect(departureProcedure('ZMBRO7', 'ZMBRO7 ODI J30 JOT')).toBe('ZMBRO7.ODI')
    expect(departureProcedure('COULT1', 'COULT1 J34 BAE')).toBe('COULT1')
    expect(departureProcedure(null, 'GOLLF GEP5')).toBeNull()
    expect(sidFromRoute('J30 JOT')).toBeNull()
    expect(starFromRoute('ZMBRO7 ODI J30 JOT VHP J24 FLM TAFTT PARQR3')).toBe('PARQR3')
    expect(starFromRoute('CVE.DRLLR5')).toBeNull()
    expect(starFromRoute('DIRECT CVE.DRLLR5')).toBe('DRLLR5')
    expect(starFromRoute('DIRECT')).toBeNull()
  })

  test('compactMap keeps runways, taxiways, parking and spots with rounded coordinates', () => {
    const map = compactMap({
      features: [
        { properties: { type: 'runway', name: '12R - 30L', threshold: '0 - 0', turnoff: 'left' }, geometry: { type: 'LineString', coordinates: [[-93.2339791, 44.8877201], [-93.2013, 44.8735]] } },
        { properties: { type: 'Taxiway', name: 'a' }, geometry: { type: 'LineString', coordinates: [[-93.21, 44.88], [-93.2, 44.88]] } },
        { properties: { type: 'parking', name: 'g16', heading: '010' }, geometry: { type: 'Point', coordinates: [-93.208115, 44.879505] } },
        { properties: { type: 'spot', name: 'S1', heading: 'x' }, geometry: { type: 'Point', coordinates: [-93.2, 44.87] } },
        { properties: { type: 'taxiway', name: '' }, geometry: { type: 'LineString', coordinates: [[0, 0]] } },
        { properties: { type: 'taxiway', name: 'B' }, geometry: { type: 'Point', coordinates: [0, 0] } },
      ],
    })
    expect(map.rwy).toEqual([{ n: '12R-30L', c: [[-93.233979, 44.88772], [-93.2013, 44.8735]], thr: '0 - 0', to: 'left' }])
    expect(map.taxi).toEqual([{ n: 'A', c: [[-93.21, 44.88], [-93.2, 44.88]] }])
    expect(map.park).toEqual({ G16: [-93.208115, 44.879505, 10] })
    expect(map.spot).toEqual({ S1: [-93.2, 44.87, 0] })
  })

  const artcc = {
    facility: {
      id: 'ZMP',
      name: 'Minneapolis ARTCC',
      positions: [],
      childFacilities: [
        {
          id: 'M98',
          name: 'Minneapolis TRACON',
          starsConfiguration: {
            videoMapIds: ['map1', 'map2', 'map3'],
            mapGroups: [{ tcps: ['1V'], mapIds: [104, null, 999] }],
            tcps: [{ id: 'tcp-1', subset: 1, sectorId: 'V' }],
            areas: [{ name: 'MSP', visibilityCenter: { lon: -93.23065, lat: 44.89039 }, surveillanceRange: 60 }],
          },
          positions: [{ id: 'p-dep', callsign: 'MSP_R_DEP', name: 'South Departure', radioName: 'Minneapolis Departure', frequency: 124700000 }],
          childFacilities: [
            {
              id: 'MSP',
              name: 'Minneapolis ATCT',
              towerCabConfiguration: { towerLocation: { lon: -93.2217, lat: 44.888274 }, videoMapId: 'twrmap' },
              asdexConfiguration: { videoMapId: 'asdex' },
              positions: [
                { id: 'p-gnd', callsign: 'MSP_S_GND', name: 'Ground', radioName: 'Minneapolis Ground', frequency: 121900000 },
                { id: 'p-twr', callsign: 'MSP_S_TWR', name: 'Local Control South', radioName: 'Minneapolis Tower', frequency: 126700000, starsConfiguration: { tcpId: 'tcp-1' } },
              ],
            },
          ],
        },
      ],
    },
    videoMaps: [
      { id: 'map1', name: 'M98 TDM', shortName: 'TDM', starsId: 999, starsBrightnessCategory: 'B', starsAlwaysVisible: true, tdmOnly: true },
      { id: 'map2', name: 'M98 104 4FINAL', shortName: '4FINAL', starsId: 104, starsBrightnessCategory: 'B' },
      { id: 'map3', name: 'Other', shortName: 'OTH', starsId: 105, tags: ['MSP'] },
    ],
  }

  test('facilityIndex flattens the tree and maps position ids to callsigns', () => {
    const fi = facilityIndex(artcc)
    expect(Object.keys(fi.facilities).sort()).toEqual(['M98', 'MSP', 'ZMP'])
    expect(fi.facilities['MSP']).toMatchObject({ parent: 'M98', tower: [-93.2217, 44.888274], asdex: 'asdex', twrmap: 'twrmap' })
    expect(fi.positions['p-gnd']).toBe('MSP_S_GND')
    expect(fi.videoMaps['map1']?.shortName).toBe('TDM')
    expect(facilityIndex(null)).toEqual({ facilities: {}, positions: {}, videoMaps: {} })
  })

  test('starsForAirport finds the host TRACON, the tower DCB maps and the departure position', () => {
    const stars = starsForAirport(facilityIndex(artcc), 'MSP')!
    expect(stars).toMatchObject({ host: 'M98', hostName: 'Minneapolis TRACON', tcp: '1V', center: [-93.23065, 44.89039], range: 60 })
    expect(stars.def).toEqual(['map2', 'map1'])
    expect(stars.maps.map((m) => m.id)).toEqual(['map1', 'map2', 'map3'])
    expect(stars.maps[0]).toEqual({ id: 'map1', sid: 999, sn: 'TDM', n: 'M98 TDM', b: 'B', av: true, tdm: true })
    expect(stars.twr).toEqual({ cs: 'MSP_S_TWR', name: 'Local Control South', radio: 'Minneapolis Tower', freq: '126.700' })
    expect(stars.dep).toEqual({ cs: 'MSP_R_DEP', name: 'South Departure', radio: 'Minneapolis Departure', freq: '124.700' })
    expect(starsForAirport(facilityIndex(artcc), 'ZZZ')).toBeNull()
    expect(formatFrequency(null)).toBeNull()
  })

  test('without a tower TCP the default maps are the always-visible and tagged ones', () => {
    const noTcp = JSON.parse(JSON.stringify(artcc))
    delete noTcp.facility.childFacilities[0].childFacilities[0].positions[1].starsConfiguration
    const stars = starsForAirport(facilityIndex(noTcp), 'MSP')!
    expect(stars.tcp).toBeNull()
    expect(stars.def).toEqual(['map1', 'map3'])
  })

  test('compactScenario groups surface aircraft by airport and counts airborne ones', () => {
    const compact = compactScenario(
      {
        id: 'scn',
        name: 'Test',
        primaryAirportId: 'MSP',
        studentPositionId: 'p-gnd',
        aircraftGenerators: [{ runway: '12r' }, { runway: '12r' }, { runway: null }],
        aircraft: [
          { aircraftId: 'AAL894', aircraftType: 'B738/L', spawnDelay: 0, startingConditions: { type: 'Parking', parking: 'e16' }, flightplan: { aircraftType: 'B738/L', route: 'ZMBRO7 ODI J30 PARQR3', departure: 'KMSP', destination: 'KCLT', rules: 'IFR', cruiseAltitude: 35000, cruiseSpeed: 250, remarks: ' E16 /V/ ' } },
          { aircraftId: 'SWA1045', startingConditions: { type: 'OnRunway', runway: '17' }, flightplan: { aircraftType: 'B737' } },
          { aircraftId: 'DAL2313', startingConditions: { type: 'OnRunway', runway: '17' }, flightplan: { aircraftType: 'A321' } },
          { aircraftId: 'SKW3892', airportId: 'msp', expectedApproach: 'ILS 12R', startingConditions: { type: 'OnFinal', runway: '12R', distanceFromRunway: 8 }, flightplan: { aircraftType: 'CRJ9' } },
          { aircraftId: 'N123', startingConditions: { type: 'Coordinates' } },
          { aircraftId: 'UAL1', airportId: 'ORD', startingConditions: { type: 'Parking', parking: 'B1' } },
        ],
      },
      { 'p-gnd': 'MSP_S_GND' },
    )
    expect(compact).toMatchObject({ id: 'scn', name: 'Test', stu: 'MSP_S_GND', n: 6, air: 1, gen: ['12R'] })
    expect(compact.byAirport['MSP']).toEqual([
      { cs: 'AAL894', ty: 'B738', d: 0, dep: 'KMSP', dst: 'KCLT', r: 'I', tyf: 'B738/L', rte: 'ZMBRO7 ODI J30 PARQR3', alt: 35000, spd: 250, rmk: 'E16 /V/', sid: 'ZMBRO7', star: 'PARQR3', k: 'P', at: 'E16' },
      { cs: 'SWA1045', ty: 'B737', d: 0, dep: null, dst: null, r: 'I', tyf: 'B737', k: 'R', at: '17', q: 0 },
      { cs: 'DAL2313', ty: 'A321', d: 0, dep: null, dst: null, r: 'I', tyf: 'A321', k: 'R', at: '17', q: 1 },
      { cs: 'SKW3892', ty: 'CRJ9', d: 0, dep: null, dst: null, r: 'I', tyf: 'CRJ9', app: 'ILS 12R', k: 'F', at: '12R', nm: 8 },
    ])
    expect(compact.byAirport['ORD']).toHaveLength(1)
    expect(scenarioForAirport(compact, 'MSP')?.ac).toHaveLength(4)
    expect(scenarioForAirport(compact, 'DEN')).toBeNull()
  })

  test('assembleAirport fills the file shape with fallbacks', () => {
    const doc = assembleAirport({
      id: 'MSP',
      artcc: 'ZMP',
      updated: null,
      facilityIndex: facilityIndex(artcc),
      airport: { jetInitialAltitude: 7000, propInitialAltitude: null, patternAltitude: 1800, trainingAircraftSets: [{ airlineIcaoCode: 'AAL', weight: 4, aircraftTypeCodes: ['A21N'] }, { airlineIcaoCode: 'DAL', weight: null, aircraftTypeCodes: null }] },
      map: { taxi: [], rwy: [], park: {}, spot: {} },
      scen: [],
    })
    expect(doc).toMatchObject({ id: 'MSP', name: 'Minneapolis ATCT', tower: [-93.2217, 44.888274], asdex: 'asdex', twrmap: 'twrmap', updated: '', init: { jet: 7000, prop: 5000, pattern: 1800 } })
    expect(doc.fleet).toEqual([{ a: 'AAL', w: 4, t: ['A21N'] }, { a: 'DAL', w: 1, t: [] }])
    expect(doc.stars?.host).toBe('M98')
    expect(assembleAirport({ id: 'X', artcc: 'Z', updated: '2024', facilityIndex: null, airport: null, map: { taxi: [], rwy: [], park: {}, spot: {} }, scen: [] })).toMatchObject({ name: 'X', stars: null, init: { jet: 5000, prop: 5000, pattern: 0 } })
  })

  test('compactScenario turns Coordinates and FixOrFrd starts into airborne records when it can place them', () => {
    const fixes = new Map([['MUSCL', [-91.78, 45.03] as const]])
    const compact = compactScenario(
      {
        id: 's',
        name: 'Air',
        primaryAirportId: 'MSP',
        aircraft: [
          { aircraftId: 'A1', aircraftType: 'E45X/L', startingConditions: { type: 'Coordinates', coordinates: { lat: 45.140323, lon: -91.74174 }, altitude: 11000, speed: 280, heading: 260, navigationPath: 'muscl3.30r' }, flightplan: { route: 'IDIOM MUSCL4', departure: 'KEWR', destination: 'KMSP' } },
          { aircraftId: 'A2', aircraftType: 'B738', startingConditions: { type: 'FixOrFrd', fix: 'MUSCL', altitude: 9000, speed: 250 } },
          { aircraftId: 'A3', aircraftType: 'B738', startingConditions: { type: 'FixOrFrd', fix: 'MUSCL090010', altitude: 9000 } },
          { aircraftId: 'A4', aircraftType: 'B738', startingConditions: { type: 'FixOrFrd', fix: 'NOPE', altitude: 9000 } },
          { aircraftId: 'A5', aircraftType: 'B738', startingConditions: { type: 'Coordinates', coordinates: { lat: 45, lon: -93 } } },
        ],
      },
      {},
      fixes,
    )
    expect(compact.air).toBe(5)
    const ac = compact.byAirport['MSP']!
    expect(ac.map((a) => a.cs)).toEqual(['A1', 'A2', 'A3'])
    expect(ac[0]).toMatchObject({ k: 'A', at: '', pos: [-91.74174, 45.140323], fa: 11000, ias: 280, hdg: 260, nav: 'MUSCL3.30R', star: 'MUSCL4' })
    expect(ac[1]).toMatchObject({ k: 'A', at: 'MUSCL', pos: [-91.78, 45.03], fa: 9000, ias: 250 })
    expect(ac[1]).not.toHaveProperty('hdg')
    expect(ac[2]!.pos![0]).toBeGreaterThan(-91.78 + 0.2)
    expect(ac[2]).toMatchObject({ ias: 250 })
  })

  test('starsForAirport finds the approach position and the centre position of the ARTCC', () => {
    const artcc = {
      facility: {
        id: 'ZMP',
        name: 'Minneapolis ARTCC',
        positions: [{ id: 'p-ctr', callsign: 'MSP_05_CTR', name: '05 ODI LO', radioName: 'Minneapolis Center', frequency: 125300000 }],
        childFacilities: [
          {
            id: 'M98',
            name: 'Minneapolis TRACON',
            starsConfiguration: { videoMapIds: [], areas: [{ name: 'MSP', visibilityCenter: { lon: -93.23, lat: 44.89 }, surveillanceRange: 60 }] },
            positions: [
              { id: 'p-dep', callsign: 'MSP_R_DEP', name: 'South Departure', radioName: 'Minneapolis Departure', frequency: 124700000 },
              { id: 'p-app', callsign: 'MSP_E_APP', name: 'Midnight', radioName: 'Minneapolis Approach', frequency: 124700000 },
            ],
            childFacilities: [{ id: 'MSP', name: 'Minneapolis ATCT', positions: [] }],
          },
        ],
      },
      videoMaps: [],
    }
    const stars = starsForAirport(facilityIndex(artcc), 'MSP')!
    expect(stars.app).toEqual({ cs: 'MSP_E_APP', name: 'Midnight', radio: 'Minneapolis Approach', freq: '124.700' })
    expect(stars.ctr).toEqual({ cs: 'MSP_05_CTR', name: '05 ODI LO', radio: 'Minneapolis Center', freq: '125.300' })
    expect(stars.dep?.cs).toBe('MSP_R_DEP')
  })

  test('assembleAirport carries the nav block and the field elevation when given', () => {
    const nav = { fixes: { MUSCL: [-91.78, 45.03] as const }, stars: {}, sids: {} }
    const doc = assembleAirport({ id: 'X', artcc: 'Z', updated: null, facilityIndex: null, airport: null, map: { taxi: [], rwy: [], park: {}, spot: {} }, scen: [], nav, elevation: 841.6 })
    expect(doc.nav).toEqual(nav)
    expect(doc.elev).toBe(842)
    expect(assembleAirport({ id: 'X', artcc: 'Z', updated: null, facilityIndex: null, airport: null, map: { taxi: [], rwy: [], park: {}, spot: {} }, scen: [] })).not.toHaveProperty('nav')
  })
})
