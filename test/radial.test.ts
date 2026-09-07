/**
 * The radial command menu: the rings a click on an aircraft offers, and the app
 * flow from a scope click through a pick to a dispatched, logged command.
 */
import { describe, expect, test } from 'bun:test'
import { Command, given, message, model, story } from 'foldkit/story'

import { FocusCommand, LoadPavement, SaveSettings } from '../src/app/commands'
import { Message } from '../src/app/message'
import { type Model, initialModel, worldOf } from '../src/app/model'
import { fullLengthEntry, intersections, newPlan, planPreview } from '../src/app/plan'
import { MAX_ITEMS, type RadialNode, openPlan, radialAt, radialRoot } from '../src/app/radial'
import { pavementFor, update } from '../src/app/update'
import type { Aircraft } from '../src/domain/aircraft'
import { parseCommandLine } from '../src/domain/commands'
import { runwayEntries } from '../src/domain/graph'
import { TRACON_RULES } from '../src/domain/rules'
import { loadScenario } from '../src/domain/scenario'
import { type World, makeWorld } from '../src/domain/world'
import type { PositionMode } from '../src/positions'
import { MAX_SPLIT, MAX_TAG_SIZE, MIN_SPLIT, MIN_TAG_SIZE, defaultSettings, mergeSettings } from '../src/services/settings'
import { toCanvas, toWorld } from '../src/view/viewport'
import { aircraftNamed, command, groundWorld, msp, runUntil, scenarioNamed, stateOf } from './helpers'

const keys = (node: RadialNode | null): ReadonlyArray<string> => (node !== null && (node._tag === 'Menu' || node._tag === 'Plan') ? node.items.map((i) => i.key) : [])
const lineAt = (world: World, mode: PositionMode, a: Aircraft, trail: ReadonlyArray<string>): string => {
  const node = radialAt(world, mode, a, trail)
  if (node === null || node._tag !== 'Line') {
    throw new Error(`${trail.join(' > ')} is not a command: ${JSON.stringify(node === null ? null : keys(node))}`)
  }
  return node.line
}

/** Every command line reachable within `depth` rings, with the rings that led there. */
const leaves = (world: World, mode: PositionMode, a: Aircraft, depth: number): ReadonlyArray<Readonly<{ trail: ReadonlyArray<string>; line: string }>> => {
  const out: Array<Readonly<{ trail: ReadonlyArray<string>; line: string }>> = []
  const walk = (node: RadialNode, trail: ReadonlyArray<string>) => {
    if (node._tag === 'Line') {
      out.push({ trail, line: node.line })
      return
    }
    if (node._tag === 'Close') {
      return
    }
    expect(node.items.length).toBeLessThanOrEqual(MAX_ITEMS)
    expect(new Set(node.items.map((i) => i.key)).size).toBe(node.items.length)
    if (trail.length >= depth) {
      return
    }
    for (const item of node.items) {
      walk(item.next(), [...trail, item.key])
    }
  }
  walk(radialRoot(world, mode, a), [])
  return out
}

describe('radial menu rings', () => {
  const world = groundWorld()
  const parked = aircraftNamed(world, 'AAL894')

  test('a parked aircraft is offered pushback, a runway and the transponder ring; TAXI only once a runway is assigned', () => {
    expect(keys(radialRoot(world, 'ground', parked))).toEqual(['push', 'rwy', 'more'])
    expect(keys(radialRoot(world, 'ground', { ...parked, runway: '30L' }))).toEqual(['push', 'rwy', 'taxi', 'more'])
    expect(lineAt(world, 'ground', parked, ['push', 'go'])).toBe('PUSH')
    const push = radialAt(world, 'ground', parked, ['push'])!
    const first = keys(push)[1]!
    expect(push._tag === 'Menu' && push.items[1]!.label).toBe(first.slice(2))
    expect(lineAt(world, 'ground', parked, ['push', first])).toBe(`PUSH ${first.slice(2)}`)
    expect(lineAt(world, 'ground', parked, ['more', 'sq', 'd:1', 'd:2', 'd:3', 'd:4'])).toBe('SQ 1234')
    expect(lineAt(world, 'ground', parked, ['more', 'del'])).toBe('DEL')
  })

  test('a runway pick proposes a route: GO issues it, intersections reroute it, crossings toggle hold short and cross', () => {
    const runways = keys(radialAt(world, 'ground', parked, ['rwy']))
    expect(runways).toEqual(Object.keys(world.graph.runwayEnds).map((d) => `r:${d}`))
    const ring = radialAt(world, 'ground', parked, ['rwy'])!
    expect(ring._tag === 'Menu' && ring.pick).toBe('runway')
    const plan = radialAt(world, 'ground', parked, ['rwy', 'r:17'])!
    expect(plan._tag).toBe('Plan')
    expect(plan._tag === 'Plan' && plan.title).toBe('RWY 17')
    expect(keys(plan)).toEqual(['go', 'at', 'cancel'])
    expect(lineAt(world, 'ground', parked, ['rwy', 'r:17', 'go'])).toBe('RWY 17')
    expect(radialAt(world, 'ground', parked, ['rwy', 'r:17', 'cancel'])?._tag).toBe('Close')
    // the preview is the line executed: E16 to 17 crosses 4-22 then 12R-30L and holds at both
    const planOf = (node: RadialNode) => (node._tag === 'Plan' ? node.plan : newPlan('17'))
    const preview = planPreview(world, parked, planOf(plan))
    expect(preview.error).toBeNull()
    expect(preview.path).toEqual(aircraftNamed(command(world, 'AAL894 RWY 17').world, 'AAL894').path)
    expect(preview.crossings.map((c) => [c.runway, c.cleared])).toEqual([
      ['4-22', false],
      ['12R-30L', false],
    ])
    // a click on the first crossing clears it with the clearance; a second click holds again
    const crossed = radialAt(world, 'ground', parked, ['rwy', 'r:17', 'x:4-22'])!
    expect(crossed._tag === 'Plan' && crossed.title).toBe('RWY 17 CROSS 4-22')
    expect(planPreview(world, parked, planOf(crossed)).crossings.map((c) => c.cleared)).toEqual([true, false])
    expect(lineAt(world, 'ground', parked, ['rwy', 'r:17', 'x:4-22', 'x:12R-30L', 'go'])).toBe('RWY 17 CROSS 4-22 12R-30L')
    expect(lineAt(world, 'ground', parked, ['rwy', 'r:17', 'x:4-22', 'x:4-22', 'go'])).toBe('RWY 17')
    // a click on an intersection off the route sends the route through it: the line names the taxiways that route uses
    const offRoute = intersections(world.graph).find((n) => !preview.path!.includes(n) && world.graph.nodeTaxiways[n]!.includes('C'))!
    const via = radialAt(world, 'ground', parked, ['rwy', 'r:17', `n:${offRoute}`])!
    expect(via._tag === 'Plan' && via.plan.waypoints).toEqual([offRoute])
    expect(via._tag === 'Plan' && via.title.startsWith('RWY 17 TAXI ')).toBe(true)
    expect(via._tag === 'Plan' && via.title.split(' ')).toContain('C')
    const rerouted = planPreview(world, parked, planOf(via))
    expect(rerouted.error).toBeNull()
    expect(rerouted.path).not.toEqual(preview.path)
    expect(radialAt(world, 'ground', parked, ['rwy', 'r:17', `n:${offRoute}`, `n:${offRoute}`])).toMatchObject({ _tag: 'Plan', title: 'RWY 17' })
    expect(radialAt(world, 'ground', parked, ['rwy', 'r:17', 'n:x'])).toBeNull()
    // an entry marker (or the AT ring) makes it an intersection departure; the full-length taxiway, or the same one again, is full length
    const atN = radialAt(world, 'ground', parked, ['rwy', 'r:17', 'e:N'])!
    expect(atN).toMatchObject({ _tag: 'Plan', title: 'RWY 17 AT N', plan: { runway: '17', at: 'N' } })
    const nPreview = planPreview(world, parked, planOf(atN))
    expect(nPreview.error).toBeNull()
    expect(runwayEntries(world.graph, '17').find((e) => e.taxiway === 'N')!.holds).toContain(nPreview.path!.at(-1)!)
    expect(lineAt(world, 'ground', parked, ['rwy', 'r:17', 'e:N', 'x:4-22', 'go'])).toBe('RWY 17 AT N CROSS 4-22')
    expect(lineAt(world, 'ground', parked, ['rwy', 'r:17', 'e:N', `n:${offRoute}`, 'go']).startsWith('RWY 17 AT N TAXI ')).toBe(true)
    expect(radialAt(world, 'ground', parked, ['rwy', 'r:17', 'e:N', 'e:N'])).toMatchObject({ _tag: 'Plan', title: 'RWY 17' })
    expect(radialAt(world, 'ground', parked, ['rwy', 'r:17', 'e:N', 'e:K10'])).toMatchObject({ _tag: 'Plan', title: 'RWY 17' })
    expect(fullLengthEntry(world.graph, '17')?.taxiway).toBe('K10')
    expect(radialAt(world, 'ground', parked, ['rwy', 'r:17', 'e:ZZ'])).toMatchObject({ _tag: 'Plan', title: 'RWY 17 AT ZZ' })
    expect(planPreview(world, parked, planOf(radialAt(world, 'ground', parked, ['rwy', 'r:17', 'e:ZZ'])!)).error).toBe('ZZ does not meet runway 17')
    const atRing = radialAt(world, 'ground', parked, ['rwy', 'r:17', 'at'])!
    expect(atRing._tag === 'Menu' && atRing.title).toBe('RWY 17 AT')
    expect(keys(atRing).slice(0, 3)).toEqual(['e:K10', 'e:L10', 'e:L9'])
    expect(radialAt(world, 'ground', parked, ['rwy', 'r:17', 'at', 'e:N'])).toMatchObject({ _tag: 'Plan', title: 'RWY 17 AT N' })
    expect(intersections(world.graph).every((n) => world.graph.nodeTaxiways[n]!.length >= 2 && world.graph.nodeRunways[n]!.length === 0)).toBe(true)
  })

  test('a taxiing aircraft can hold short of, or cross, what lies ahead on its route; an arrival is offered its gate', () => {
    // E16 to 30L goes around every runway; to 17 via A it crosses 4-22 and 12R-30L
    const around = aircraftNamed(command(world, 'AAL894 RWY 30L').world, 'AAL894')
    expect(keys(radialRoot(world, 'ground', around))).toEqual(['rwy', 'taxi', 'hs', 'hold', 'break', 'gw', 'luaw', 'cto', 'more'])
    const taxiing = aircraftNamed(command(world, 'AAL894 RWY 17 TAXI A').world, 'AAL894')
    const root = keys(radialRoot(world, 'ground', taxiing))
    expect(root).toEqual(['rwy', 'taxi', 'hs', 'x', 'hold', 'break', 'gw', 'luaw', 'cto', 'more'])
    const points = keys(radialAt(world, 'ground', taxiing, ['hs']))
    expect(points.slice(0, 2)).toEqual(['p:D', 'p:C6'])
    expect(points).toContain('p:12R-30L')
    expect(lineAt(world, 'ground', taxiing, ['hs', 'p:12R-30L'])).toBe('HS 12R-30L')
    expect(keys(radialAt(world, 'ground', taxiing, ['x']))).toEqual(['x', 'r:12R-30L'])
    expect(lineAt(world, 'ground', taxiing, ['x', 'x'])).toBe('CROSS')
    expect(lineAt(world, 'ground', taxiing, ['x', 'r:12R-30L'])).toBe('CROSS 12R-30L')
    expect(lineAt(world, 'ground', taxiing, ['cto', 'go'])).toBe('CTO')
    expect(lineAt(world, 'ground', taxiing, ['cto', 'tl', 'h:240', 'h:250'])).toBe('CTO L 250')
    const arriving: Aircraft = { ...taxiing, runway: null, destinationGate: 'G12' }
    expect(lineAt(world, 'ground', arriving, ['taxi', 'g:G12'])).toBe('TAXI G12')
    const first = keys(radialAt(world, 'ground', arriving, ['taxi'])).find((k) => k.startsWith('t:'))!
    expect(lineAt(world, 'ground', arriving, ['taxi', first, 'g:G12'])).toBe(`TAXI ${first.slice(2)} G12`)
  })

  test('holding short, the first entries are the crossing and continuing', () => {
    const { world: rolled } = runUntil(command(world, 'AAL894 RWY 17 TAXI A').world, stateOf('AAL894', 'SHORT'), 600)
    const short = aircraftNamed(rolled, 'AAL894')
    expect(keys(radialRoot(rolled, 'ground', short)).slice(0, 2)).toEqual(['x', 'res'])
    const crossing = radialAt(rolled, 'ground', short, ['x'])!
    expect(crossing._tag === 'Menu' && crossing.items[0]!.label).toBe('4-22')
    expect(lineAt(rolled, 'ground', short, ['x', 'x'])).toBe('CROSS')
    expect(lineAt(rolled, 'ground', short, ['x', 'r:12R-30L'])).toBe('CROSS 12R-30L')
    expect(lineAt(rolled, 'ground', short, ['res'])).toBe('RES')
    const others = keys(radialAt(rolled, 'ground', short, ['gw']))
    expect(others.length).toBeGreaterThan(0)
    expect(others).not.toContain('c:AAL894')
  })

  test('airborne rings: headings by compass sector, altitudes, speeds, fixes from the route, and the approach set', () => {
    const { world: app } = loadScenario(makeWorld(msp, TRACON_RULES, 1), scenarioNamed('Ancient MSP APP North'))
    const a = app.aircraft.find((x) => x.state === 'AIRB' && x.delay <= 0 && x.fixes.length > 0)!
    expect(a.radar).toBeNull()
    expect(keys(radialRoot(app, 'tracon', a))).toEqual(['alt', 'spd', 'dct', 'hdg', 'exp', 'capp', 'ct', 'cd', 'more'])
    const painted = { ...a, radar: { position: a.position, altitude: a.altitude, speed: a.speed, history: [] } }
    expect(keys(radialRoot(app, 'tracon', { ...painted, tracked: false }))).toContain('track')
    expect(keys(radialRoot(app, 'tracon', { ...painted, tracked: true }))).toContain('drop')
    const sectors = keys(radialAt(app, 'tracon', a, ['hdg', 'fh']))
    expect(sectors).toHaveLength(12)
    expect(sectors[0]).toBe('h:0')
    const fine = radialAt(app, 'tracon', a, ['hdg', 'fh', 'h:0'])!
    expect(fine._tag === 'Menu' && fine.items.map((i) => i.label)).toEqual(['360', '005', '010', '015', '020', '025'])
    expect(lineAt(app, 'tracon', a, ['hdg', 'fh', 'h:0', 'h:0'])).toBe('FH 360')
    expect(lineAt(app, 'tracon', a, ['hdg', 'tr', 'h:90', 'h:95'])).toBe('TR 095')
    expect(lineAt(app, 'tracon', a, ['alt', 'a:4000'])).toBe('DM 4000')
    expect(lineAt(app, 'tracon', a, ['alt', 'a:13000'])).toBe(a.altitude < 13000 ? 'CM 13000' : 'DM 13000')
    expect(lineAt(app, 'tracon', a, ['spd', 'resume'])).toBe('SPD')
    expect(lineAt(app, 'tracon', a, ['spd', 's:210'])).toBe('SPD 210')
    expect(lineAt(app, 'tracon', a, ['dct', `f:${a.fixes[0]}`])).toBe(`DCT ${a.fixes[0]}`)
    expect(lineAt(app, 'tracon', a, ['exp', 'r:30L'])).toBe('EXP 30L')
    expect(lineAt(app, 'tracon', a, ['capp', 'go'])).toBe('CAPP')
    expect(lineAt(app, 'tracon', a, ['ct'])).toBe('CT')
    expect(keys(radialRoot(app, 'tower', a))).toEqual(['cd', 'alt', 'spd', 'dct', 'hdg', 'more'])
  })

  test('every reachable entry is a line the parser accepts', () => {
    const { world: app } = loadScenario(makeWorld(msp, TRACON_RULES, 1), scenarioNamed('Ancient MSP APP North'))
    const airborne = app.aircraft.find((x) => x.state === 'AIRB' && x.delay <= 0)!
    const taxiing = aircraftNamed(command(world, 'AAL894 RWY 30L').world, 'AAL894')
    const cases: ReadonlyArray<readonly [World, PositionMode, Aircraft]> = [
      [world, 'ground', parked],
      [world, 'ground', taxiing],
      [app, 'tracon', airborne],
      [app, 'tower', airborne],
    ]
    let count = 0
    for (const [w, mode, a] of cases) {
      for (const { trail, line } of leaves(w, mode, a, 4)) {
        const parsed = parseCommandLine(w, null, `${a.callsign} ${line}`)
        expect(parsed._tag === 'Parsed' ? parsed.callsign : `${trail.join(' > ')}: ${JSON.stringify(parsed)}`).toBe(a.callsign)
        count++
      }
    }
    expect(count).toBeGreaterThan(500)
    expect(radialAt(world, 'ground', parked, ['nope'])).toBeNull()
    expect(radialAt(world, 'ground', parked, ['push', 'go', 'go'])).toBeNull()
  })
})

describe('radial menu in the app', () => {
  const index = {
    built: '',
    artccs: [{ id: 'ZMP', name: 'Minneapolis ARTCC', airports: [{ id: 'MSP', name: 'Minneapolis ATCT', n: 64, asdex: true, gates: 220, taxi: 106, stars: true }] }],
  }
  const scenario = scenarioNamed('KMSP 12s/17 SLCL 5MIT')
  const ready = (): Model => {
    let m = update(initialModel, Message.CompletedLoadSettings({ settings: { ...defaultSettings, tts: false } })).model
    m = update(m, Message.CompletedReadDeepLink({ airport: 'MSP', scenario: scenario.id, room: null })).model
    m = update(m, Message.ResizedScope({ width: 1000, height: 700, devicePixelRatio: 2 })).model
    m = update(m, Message.CompletedLoadIndex({ index })).model
    m = update(m, Message.CompletedLoadAirport({ airport: msp })).model
    m = update(m, Message.CompletedLoadScenario({ airportId: 'MSP', scenario })).model
    return m
  }

  test('a right-click on an aircraft opens the ring; picks descend it; a command pick dispatches, logs and closes', () => {
    const m = ready()
    const world = worldOf(m)!
    const p = toCanvas(m.scope, toWorld(world.graph, aircraftNamed(world, 'AAL894').position))
    story(
      update,
      given(m),
      message(Message.ContextScope({ x: p.x, y: p.y })),
      Command.expectExact(FocusCommand),
      Command.resolve(FocusCommand, Message.CompletedFocusCommand()),
      model((n) => {
        expect(n.selected).toBe('AAL894')
        expect(n.radial).toEqual({ callsign: 'AAL894', trail: [] })
      }),
      message(Message.PickedRadial({ key: 'rwy' })),
      message(Message.PickedRadial({ key: 'r:30L' })),
      model((n) => expect(n.radial?.trail).toEqual(['rwy', 'r:30L'])),
      message(Message.PickedRadial({ key: 'stale' })),
      model((n) => expect(n.radial?.trail).toEqual(['rwy', 'r:30L'])),
      message(Message.ClickedRadialBack()),
      model((n) => expect(n.radial?.trail).toEqual(['rwy'])),
      message(Message.PickedRadial({ key: 'r:30L' })),
      message(Message.PickedRadial({ key: 'go' })),
      Command.expectNone(),
      model((n) => {
        expect(n.radial).toBeNull()
        expect(n.history[0]).toBe('AAL894 RWY 30L')
        expect(n.log[1]?.kind).toBe('atc')
        expect(n.log[1]?.text).toBe('AAL894 RWY 30L')
        expect(n.log[0]?.kind).toBe('pilot')
        expect(n.log[0]?.text).toBe('runway 30L, taxi via D B A')
        expect(aircraftNamed(worldOf(n)!, 'AAL894').state).toBe('TAXI')
        expect(n.commandLog.at(-1)?.command._tag).toBe('Runway')
      }),
    )
  })

  test('runway buttons pick a runway from the root or the runway ring; scope clicks edit the proposed route; ✕ rejects it', () => {
    const m = ready()
    const world = worldOf(m)!
    const graph = world.graph
    const at = (n: number) => toCanvas(m.scope, toWorld(graph, graph.nodes[n]!))
    const p = toCanvas(m.scope, toWorld(graph, aircraftNamed(world, 'AAL894').position))
    const opened = update(m, Message.ContextScope({ x: p.x, y: p.y })).model
    expect(update(opened, Message.PickedRunwayButton({ designator: '30L' })).model.radial?.trail).toEqual(['rwy', 'r:30L'])
    expect(update(opened, Message.PickedRunwayButton({ designator: '99' })).model.radial?.trail).toEqual([])
    // with a plan open, a click on an entry marker on the runway centreline enters there; on the full-length one, full length again
    const on30L = update(opened, Message.PickedRunwayButton({ designator: '30L' })).model
    const d = runwayEntries(graph, '30L').find((e) => e.taxiway === 'D')!
    const clickNode = (from: Model, node: number): Model => {
      const q = at(node)
      return update(update(from, Message.PressedScope({ x: q.x, y: q.y })).model, Message.ReleasedScope({ x: q.x, y: q.y })).model
    }
    const atD = clickNode(on30L, d.node)
    expect(atD.radial?.trail).toEqual(['rwy', 'r:30L', 'e:D'])
    expect(openPlan(worldOf(atD)!, 'ground', atD.radial)?.preview.line).toBe('RWY 30L AT D')
    const full = clickNode(atD, graph.runwayEnds['30L']!.chain[0]!)
    expect(full.radial?.trail).toEqual(['rwy', 'r:30L', 'e:D', 'e:A1'])
    expect(openPlan(worldOf(full)!, 'ground', full.radial)?.preview.line).toBe('RWY 30L')
    const went = update(atD, Message.PickedRadial({ key: 'go' })).model
    expect(went.history[0]).toBe('AAL894 RWY 30L AT D')
    expect(went.log[0]?.text).toBe('runway 30L at D, taxi via D')
    expect(aircraftNamed(worldOf(went)!, 'AAL894').intersection).toBe('D')
    const ring = update(opened, Message.PickedRadial({ key: 'rwy' })).model
    const planned = update(ring, Message.PickedRunwayButton({ designator: '17' })).model
    expect(planned.radial?.trail).toEqual(['rwy', 'r:17'])
    const open = openPlan(world, 'ground', planned.radial)!
    expect(open.preview.line).toBe('RWY 17')
    const click = (model: Model, x: number, y: number): Model => update(update(model, Message.PressedScope({ x, y })).model, Message.ReleasedScope({ x, y })).model
    const first = open.preview.crossings[0]!
    const crossed = click(planned, at(first.node).x, at(first.node).y)
    expect(crossed.radial?.trail).toEqual(['rwy', 'r:17', 'x:4-22'])
    expect(openPlan(world, 'ground', crossed.radial)?.preview.line).toBe('RWY 17 CROSS 4-22')
    const farFromCrossings = (n: number) => open.preview.crossings.every((c) => Math.hypot(at(c.node).x - at(n).x, at(c.node).y - at(n).y) > 60)
    const node = intersections(graph).find((n) => !open.preview.path!.includes(n) && farFromCrossings(n))!
    const rerouted = click(crossed, at(node).x, at(node).y)
    expect(rerouted.radial?.trail).toEqual(['rwy', 'r:17', 'x:4-22', `n:${node}`])
    expect(openPlan(world, 'ground', rerouted.radial)?.preview.line.startsWith('RWY 17 TAXI ')).toBe(true)
    expect(click(rerouted, 2, 2).radial).toEqual(rerouted.radial)
    expect(update(rerouted, Message.ClickedRadialBack()).model.radial?.trail).toEqual(['rwy', 'r:17', 'x:4-22'])
    expect(update(rerouted, Message.PickedRadial({ key: 'cancel' })).model.radial).toBeNull()
    const issued = update(rerouted, Message.PickedRadial({ key: 'go' })).model
    expect(issued.radial).toBeNull()
    expect(issued.history[0]).toBe(`AAL894 ${openPlan(world, 'ground', rerouted.radial)!.preview.line}`)
    expect(aircraftNamed(worldOf(issued)!, 'AAL894').cleared).toEqual(['4-22'])
  })

  test('a plain click only selects; the pane split is clamped, saved on release, and merged from storage', () => {
    const m = ready()
    const world = worldOf(m)!
    const p = toCanvas(m.scope, toWorld(world.graph, aircraftNamed(world, 'AAL894').position))
    const clicked = update(update(m, Message.PressedScope({ x: p.x, y: p.y })).model, Message.ReleasedScope({ x: p.x, y: p.y })).model
    expect(clicked.selected).toBe('AAL894')
    expect(clicked.radial).toBeNull()
    const dragged = update(m, Message.DraggedSplit({ ratio: 0.9 }))
    expect(dragged.model.settings.split).toBe(MAX_SPLIT)
    expect(dragged.commands ?? []).toEqual([])
    expect(update(m, Message.DraggedSplit({ ratio: -1 })).model.settings.split).toBe(MIN_SPLIT)
    expect(update(m, Message.DraggedSplit({ ratio: 0.33333 })).model.settings.split).toBe(0.333)
    const released = update(dragged.model, Message.ReleasedSplit())
    expect(released.commands?.map((c) => c.name)).toEqual([SaveSettings.name])
    expect(mergeSettings({ split: 5 })).toEqual(defaultSettings)
    expect(mergeSettings({ split: 0.3, radialMenu: false })).toEqual({ ...defaultSettings, split: 0.3 })
    expect(update(update(m, Message.ClickedAsdexPanel()).model, Message.PressedOutsideAsdexPanel()).model.asdexPanelOpen).toBe(false)
    expect(update(m, Message.ToggledParkedTags()).model.settings.asdexParkedTags).toBe(true)
    let n = m
    for (let i = 0; i < 20; i++) {
      n = update(n, Message.ChangedTagSize({ delta: 1 })).model
    }
    expect(n.settings.asdexTagSize).toBe(MAX_TAG_SIZE)
    expect(update(n, Message.ChangedTagSize({ delta: -100 })).model.settings.asdexTagSize).toBe(MIN_TAG_SIZE)
    expect(mergeSettings({ asdexTagSize: 40 })).toEqual(defaultSettings)
  })

  test('the DISP panel can swap ASDE-X pavement for the tower-cab map where the airport has both', () => {
    expect(pavementFor('A', 'C', false)).toEqual({ id: 'A', asdex: true })
    expect(pavementFor('A', 'C', true)).toEqual({ id: 'C', asdex: false })
    expect(pavementFor('A', null, true)).toEqual({ id: 'A', asdex: true })
    expect(pavementFor(null, 'C', false)).toEqual({ id: 'C', asdex: false })
    expect(pavementFor(null, null, true)).toBeNull()
    const m = ready()
    expect(m.pavement).toEqual({ _tag: 'Loading', id: msp.asdex! })
    const on = update(m, Message.ToggledCabMap())
    expect(on.model.settings.asdexCabMap).toBe(true)
    expect(on.model.pavement).toEqual({ _tag: 'Loading', id: msp.twrmap! })
    expect(on.commands?.map((c) => c.name)).toEqual([SaveSettings.name, LoadPavement.name])
    const off = update(on.model, Message.ToggledCabMap())
    expect(off.model.pavement).toEqual({ _tag: 'Loading', id: msp.asdex! })
    // layers toggle only on a ready cab map, and are remembered per map id
    expect(update(m, Message.ToggledCabLayer({ key: 'line:#fcb737:3' })).model.settings.cabLayersOff).toEqual({})
    const cab = update(on.model, Message.CompletedLoadPavement({ id: msp.twrmap!, asdex: false })).model
    const one = update(cab, Message.ToggledCabLayer({ key: 'line:#fcb737:3' }))
    expect(one.model.settings.cabLayersOff).toEqual({ [msp.twrmap!]: ['line:#fcb737:3'] })
    expect(one.commands?.map((c) => c.name)).toEqual([SaveSettings.name])
    const two = update(one.model, Message.ToggledCabLayer({ key: 'fill:#343434:1' })).model
    expect(two.settings.cabLayersOff[msp.twrmap!]).toEqual(['line:#fcb737:3', 'fill:#343434:1'])
    expect(update(update(two, Message.ToggledCabLayer({ key: 'line:#fcb737:3' })).model, Message.ToggledCabLayer({ key: 'fill:#343434:1' })).model.settings.cabLayersOff).toEqual({})
    expect(mergeSettings({ cabLayersOff: { a: ['x'] } }).cabLayersOff).toEqual({ a: ['x'] })
    expect(mergeSettings({ cabLayersOff: 'nope' }).cabLayersOff).toEqual({})
  })

  test('the ring closes at its root, on Escape, on a click over empty pavement, and when another aircraft is selected', () => {
    const m = ready()
    const world = worldOf(m)!
    const p = toCanvas(m.scope, toWorld(world.graph, aircraftNamed(world, 'AAL894').position))
    const open = (): Model => {
      // a right-click on macOS: the press starts a drag, the context menu event lands before the release
      let n = update(m, Message.PressedScope({ x: p.x, y: p.y })).model
      n = update(n, Message.ContextScope({ x: p.x, y: p.y })).model
      expect(n.drag).toBeNull()
      n = update(n, Message.ReleasedScope({ x: p.x, y: p.y })).model
      expect(n.radial).toEqual({ callsign: 'AAL894', trail: [] })
      return n
    }
    expect(update(open(), Message.ClickedRadialBack()).model.radial).toBeNull()
    expect(update(open(), Message.ClosedRadial()).model.radial).toBeNull()
    const empty = update(update(open(), Message.PressedScope({ x: 5, y: 5 })).model, Message.ReleasedScope({ x: 5, y: 5 })).model
    expect(empty.radial).toBeNull()
    expect(empty.selected).toBe('AAL894')
    expect(update(open(), Message.ContextScope({ x: 5, y: 5 })).model.radial).toBeNull()
    const second = world.aircraft.find((a) => a.callsign !== 'AAL894')!.callsign
    const other = update(open(), Message.ClickedStrip({ callsign: second })).model
    expect(other.radial).toBeNull()
    expect(other.selected).toBe(second)
    const dragged = update(update(update(open(), Message.PressedScope({ x: 100, y: 100 })).model, Message.MovedScope({ x: 150, y: 120 })).model, Message.ReleasedScope({ x: 150, y: 120 })).model
    expect(dragged.radial).toEqual({ callsign: 'AAL894', trail: [] })
  })
})
