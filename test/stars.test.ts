import { describe, expect, test } from 'bun:test'

import { LoadStarsMap, StarsMessage, StarsOut, canvasToNm, defaultMaps, initialMaps, initialStars, isDefaultMaps, radarPoint, rangeView, starsInit, starsUpdate, targetAt, toCanvas, zoomAt } from '../src/positions/local/stars'
import { LOCAL_RULES } from '../src/domain/rules'
import { command, emptyWorld, groundWorld, msp, runUntil, stateOf } from './helpers'

describe('STARS pane', () => {
  const stars = msp.stars!

  test('default maps are the tower DCB list (first 4) plus always-visible ones, loaded on init', () => {
    const ids = defaultMaps(stars)
    expect(ids).toContain(stars.def[0]!)
    expect(ids.filter((id) => stars.def.includes(id))).toHaveLength(4)
    for (const m of stars.maps.filter((x) => x.av)) {
      expect(ids).toContain(m.id)
    }
    expect(defaultMaps(null)).toEqual([])
    const init = starsInit(initialStars, 'ZMP', stars)
    expect(init.model.shown).toEqual(ids)
    expect(init.model.view).toEqual(rangeView(15))
    expect(init.commands?.map((c) => c.name)).toEqual(ids.map(() => LoadStarsMap.name))
    const again = starsInit({ ...init.model, loaded: ids }, 'ZMP', stars)
    expect(again.commands).toEqual([])
  })

  test('a remembered selection replaces the defaults on init, minus ids the catalog no longer has', () => {
    const ids = defaultMaps(stars)
    const other = stars.maps.find((m) => !ids.includes(m.id))!.id
    expect(initialMaps(stars, null)).toEqual(ids)
    expect(initialMaps(stars, [other, 'gone'])).toEqual([other])
    expect(initialMaps(stars, [])).toEqual([])
    expect(initialMaps(null, [other])).toEqual([])
    expect(isDefaultMaps(stars, ids)).toBe(true)
    expect(isDefaultMaps(stars, [...ids].reverse())).toBe(true)
    expect(isDefaultMaps(stars, [...ids, other])).toBe(false)
    expect(isDefaultMaps(stars, ids.slice(1))).toBe(false)
    const init = starsInit(initialStars, 'ZMP', stars, 15, [other])
    expect(init.model.shown).toEqual([other])
    expect(init.commands?.map((c) => c.args)).toEqual([{ artcc: 'ZMP', id: other }])
  })

  test('the radar plane is letterboxed and zooms about the cursor within 6 to 320 nm', () => {
    const model = { ...initialStars, width: 800, height: 400 }
    expect(toCanvas(model, 0, 0)).toEqual({ x: 400, y: 200 })
    expect(toCanvas(model, 15, 0).x).toBeCloseTo(600, 6)
    const back = canvasToNm(model, 600, 200)
    expect(back.x).toBeCloseTo(15, 6)
    expect(back.y).toBeCloseTo(0, 6)
    const zoomed = zoomAt(model, 600, 200, 0.5)
    expect(zoomed.w).toBe(15)
    expect(canvasToNm({ ...model, view: zoomed }, 600, 200).x).toBeCloseTo(15, 6)
    expect(zoomAt(model, 400, 200, 0.01).w).toBe(6)
    expect(zoomAt(model, 400, 200, 100).w).toBe(320)
  })

  test('MAPS toggles the panel; a press outside it closes it and is otherwise ignored', () => {
    const run = (m: typeof initialStars, message: StarsMessage) => starsUpdate(m, 'ZMP', { message, world: null }).model
    const opened = run(initialStars, StarsMessage.ClickedMaps())
    expect(opened.mapsOpen).toBe(true)
    const closed = run(opened, StarsMessage.PressedOutsideMaps())
    expect(closed.mapsOpen).toBe(false)
    expect(run(closed, StarsMessage.PressedOutsideMaps()).mapsOpen).toBe(false)
    expect(run(opened, StarsMessage.ClickedMaps()).mapsOpen).toBe(false)
  })

  test('range buttons step by 1.5 within 3 to 160 nm and CTR restores 15', () => {
    const run = (m: typeof initialStars, message: StarsMessage) => starsUpdate(m, 'ZMP', { message, world: null }).model
    let m = initialStars
    m = run(m, StarsMessage.ClickedRangeOut())
    expect(m.view.w / 2).toBe(23)
    m = run(m, StarsMessage.ClickedRangeIn())
    expect(m.view.w / 2).toBe(15)
    for (let i = 0; i < 10; i++) {
      m = run(m, StarsMessage.ClickedRangeIn())
    }
    expect(m.view.w / 2).toBe(3)
    for (let i = 0; i < 20; i++) {
      m = run(m, StarsMessage.ClickedRangeOut())
    }
    expect(m.view.w / 2).toBe(160)
    expect(run(m, StarsMessage.ClickedCentre()).view).toEqual(rangeView(15))
  })

  test('a drag pans; a click near a radar return selects it through an OutMessage', () => {
    const world = { ...groundWorld(LOCAL_RULES), arrivalsEnabled: true }
    const spawned = runUntil(world, (w) => w.aircraft.some((a) => a.radar !== null), 15).world
    const arrival = spawned.aircraft.find((a) => a.radar !== null)!
    const model = { ...initialStars, width: 600, height: 600 }
    const p = radarPoint(spawned, arrival.radar!.position)
    const c = toCanvas(model, p.x, p.y)
    const pressed = starsUpdate(model, 'ZMP', { message: StarsMessage.Pressed({ x: c.x, y: c.y }), world: spawned }).model
    const released = starsUpdate(pressed, 'ZMP', { message: StarsMessage.Released({ x: c.x, y: c.y }), world: spawned })
    expect(released.outMessage).toEqual(StarsOut.SelectedTarget({ callsign: arrival.callsign }))
    expect(released.model.drag).toBeNull()
    const far = starsUpdate(pressed, 'ZMP', { message: StarsMessage.Released({ x: c.x + 200, y: c.y + 200 }), world: spawned })
    expect(far.outMessage).toEqual(StarsOut.ClickedEmpty())
    const dragged = starsUpdate(pressed, 'ZMP', { message: StarsMessage.Moved({ x: c.x + 60, y: c.y }), world: spawned }).model
    expect(dragged.view.x).toBeCloseTo(model.view.x - 60 / 20, 6)
    expect(starsUpdate(dragged, 'ZMP', { message: StarsMessage.Released({ x: c.x + 60, y: c.y }), world: spawned }).outMessage).toBeUndefined()
  })

  test('a right-click reports the target under it (or none) and drops the drag the press started', () => {
    const world = { ...groundWorld(LOCAL_RULES), arrivalsEnabled: true }
    const spawned = runUntil(world, (w) => w.aircraft.some((a) => a.radar !== null), 15).world
    const arrival = spawned.aircraft.find((a) => a.radar !== null)!
    const model = { ...initialStars, width: 600, height: 600 }
    const p = radarPoint(spawned, arrival.radar!.position)
    const c = toCanvas(model, p.x, p.y)
    expect(targetAt(model, spawned, c.x, c.y)).toBe(arrival.callsign)
    expect(targetAt(model, spawned, c.x + 200, c.y + 200)).toBeNull()
    const pressed = starsUpdate(model, 'ZMP', { message: StarsMessage.Pressed({ x: c.x, y: c.y }), world: spawned }).model
    const context = starsUpdate(pressed, 'ZMP', { message: StarsMessage.Context({ x: c.x, y: c.y }), world: spawned })
    expect(context.outMessage).toEqual(StarsOut.ContextTarget({ callsign: arrival.callsign }))
    expect(context.model.drag).toBeNull()
    const empty = starsUpdate(model, 'ZMP', { message: StarsMessage.Context({ x: c.x + 200, y: c.y + 200 }), world: spawned })
    expect(empty.outMessage).toEqual(StarsOut.ContextTarget({ callsign: null }))
    expect(starsUpdate(model, 'ZMP', { message: StarsMessage.Context({ x: c.x, y: c.y }), world: null }).outMessage).toBeUndefined()
  })

  test('toggling a map loads it once; a failed map is removed and noted', () => {
    const id = stars.maps[5]!.id
    const on = starsUpdate(initialStars, 'ZMP', { message: StarsMessage.ToggledMap({ id }), world: null })
    expect(on.model.shown).toEqual([id])
    expect(on.commands?.map((c) => [c.name, c.args])).toEqual([[LoadStarsMap.name, { artcc: 'ZMP', id }]])
    const loaded = starsUpdate(on.model, 'ZMP', { message: StarsMessage.CompletedLoadMap({ id }), world: null }).model
    expect(loaded.loaded).toEqual([id])
    const off = starsUpdate(loaded, 'ZMP', { message: StarsMessage.ToggledMap({ id }), world: null })
    expect(off.model.shown).toEqual([])
    const onAgain = starsUpdate(off.model, 'ZMP', { message: StarsMessage.ToggledMap({ id }), world: null })
    expect(onAgain.commands).toBeUndefined()
    const failed = starsUpdate(onAgain.model, 'ZMP', { message: StarsMessage.FailedLoadMap({ id, error: 'HTTP 404' }), world: null })
    expect(failed.model.shown).toEqual([])
    expect(failed.outMessage).toEqual(StarsOut.Noted({ text: `map ${id}: HTTP 404` }))
  })

  test('a departure appears on radar once rolling above 40 kt', () => {
    const world = runUntil(command(groundWorld(), 'AAL894 RWY 30L').world, stateOf('AAL894', 'SHORT'), 900).world
    const rolling = runUntil(command(world, 'AAL894 CTO').world, (w) => w.aircraft.find((a) => a.callsign === 'AAL894')!.radar !== null, 60)
    const a = rolling.world.aircraft.find((x) => x.callsign === 'AAL894')!
    expect(a.speed).toBeGreaterThan(40)
    expect(emptyWorld().airport.radarCenter).toEqual(msp.stars!.center)
  })
})
