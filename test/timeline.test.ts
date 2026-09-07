import { describe, expect, test } from 'bun:test'

import type { LogLine } from '../src/app/log'
import { KEYFRAME_STEPS, MIN_EXTENT_STEPS, axisTicks, branchOf, commandLogAt, extent, lanes, logAt, parkBranch, pointAt, recordChange, recordSteps, resolvePoint, resumeAt, startTimeline, worldAt } from '../src/app/timeline'
import { AtcCommand } from '../src/domain/commands'
import { stepWorld, stepWorldTimes } from '../src/domain/physics'
import { GROUND_RULES, LOCAL_RULES } from '../src/domain/rules'
import type { World } from '../src/domain/world'
import { command, groundWorld } from './helpers'

/**
 * A scripted session: the World at every tick (the truth), and the timeline as
 * the app would have recorded it, stepping in tick-sized batches of eight.
 */
const session = () => {
  const truth: Array<World> = []
  let world = groundWorld()
  let timeline = startTimeline(world)
  truth[world.tick] = world
  const steps = (n: number) => {
    for (let i = 0; i < n; i += 8) {
      const batch = Math.min(8, n - i)
      world = stepWorldTimes(world, batch).world
      for (let k = batch; k >= 1; k--) {
        truth[world.tick - k + 1] = stepWorld(truth[world.tick - k]!).world
      }
      timeline = recordSteps(timeline, world)
    }
  }
  const change = (next: World, label: string) => {
    world = next
    truth[world.tick] = world
    timeline = recordChange(timeline, world, label)
  }
  steps(120)
  change(command(world, 'AAL894 PUSH').world, 'AAL894 PUSH')
  steps(400)
  change({ ...world, arrivalsEnabled: true, nextArrivalAt: world.simTime + 5 }, 'arrivals on')
  steps(700)
  change(command(world, 'AAL894 RWY 30L TAXI D').world, 'AAL894 RWY 30L TAXI D')
  change(command(world, 'AAL894 HS B').world, 'AAL894 HS B')
  steps(50)
  change({ ...world, rules: LOCAL_RULES }, 'Local position')
  steps(37)
  return { truth, timeline, world }
}

describe('recording', () => {
  test('a keyframe at every change plus one every KEYFRAME_STEPS, two changes at one tick merged', () => {
    const { timeline } = session()
    const root = branchOf(timeline, 0)!
    expect(root.forkTick).toBe(0)
    expect(root.endTick).toBe(120 + 400 + 700 + 50 + 37)
    const labelled = root.keyframes.filter((k) => k.label !== null).map((k) => [k.tick, k.label])
    expect(labelled).toEqual([
      [120, 'AAL894 PUSH'],
      [520, 'arrivals on'],
      [1220, 'AAL894 RWY 30L TAXI D · AAL894 HS B'],
      [1270, 'Local position'],
    ])
    const ticks = root.keyframes.map((k) => k.tick)
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b))
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]! - ticks[i - 1]!).toBeLessThanOrEqual(KEYFRAME_STEPS + 8)
    }
    expect(root.keyframes.some((k) => k.label === null && k.tick > 0)).toBe(true)
  })

  test('the World at any tick rebuilds exactly from the keyframes', () => {
    const { truth, timeline, world } = session()
    for (const tick of [0, 1, 7, 119, 120, 121, 300, 519, 520, 521, 800, 1219, 1220, 1221, 1269, 1270, 1271, world.tick]) {
      expect(worldAt(timeline, { branch: 0, tick })).toEqual(truth[tick]!)
    }
  })

  test('a hint on the same branch is stepped instead of the keyframe when that is fewer steps', () => {
    const { truth, timeline } = session()
    const shown = worldAt(timeline, { branch: 0, tick: 700 })!
    expect(worldAt(timeline, { branch: 0, tick: 710 }, { point: { branch: 0, tick: 700 }, world: shown })).toEqual(truth[710]!)
    expect(worldAt(timeline, { branch: 0, tick: 690 }, { point: { branch: 0, tick: 700 }, world: shown })).toEqual(truth[690]!)
    expect(worldAt(timeline, { branch: 0, tick: 710 }, { point: { branch: 1, tick: 700 }, world: shown })).toEqual(truth[710]!)
  })
})

describe('branches', () => {
  const line = (time: number, text: string): LogLine => ({ kind: 'sys', time, who: null, text })

  test('resuming before the end forks; at the end it continues; the log and command log follow the fork point', () => {
    const { truth, timeline } = session()
    const parked = parkBranch(
      timeline,
      [line(127, 'after'), line(12, 'at the push'), line(0, 'start')],
      [{ tick: 120, callsign: 'AAL894', command: AtcCommand.Push({ taxiway: null }) }, { tick: 1220, callsign: 'AAL894', command: AtcCommand.HoldShort({ point: 'A3' }) }],
    )
    const forked = resumeAt(parked, { branch: 0, tick: 600 }, truth[600]!)!
    expect(forked.forked).toBe(true)
    expect(forked.timeline.current).toBe(1)
    expect(forked.branch).toMatchObject({ id: 1, parent: 0, forkTick: 600, endTick: 600 })
    expect(forked.branch.keyframes).toEqual([{ tick: 600, label: null, world: truth[600]! }])
    expect(forked.branch.log.map((l) => l.text)).toEqual(['at the push', 'start'])
    expect(forked.branch.commandLog.map((c) => c.tick)).toEqual([120])
    expect(branchOf(forked.timeline, 0)!.endTick).toBe(1307)

    const continued = resumeAt(forked.timeline, { branch: 0, tick: 1307 }, truth[1307]!)!
    expect(continued.forked).toBe(false)
    expect(continued.timeline.current).toBe(0)
    expect(continued.timeline.branches).toHaveLength(2)
    expect(continued.branch.log).toHaveLength(3)
  })

  test('the fork extends on its own; its parent keeps its end; a point before the fork belongs to the parent', () => {
    const { truth, timeline } = session()
    const forked = resumeAt(timeline, { branch: 0, tick: 600 }, truth[600]!)!
    let t = forked.timeline
    let w = truth[600]!
    for (let i = 0; i < 5; i++) {
      w = stepWorldTimes(w, 8).world
      t = recordSteps(t, w)
    }
    w = command(w, 'AAL894 RWY 30L TAXI D').world
    t = recordChange(t, w, 'AAL894 RWY 30L TAXI D')
    expect(branchOf(t, 1)!.endTick).toBe(640)
    expect(branchOf(t, 0)!.endTick).toBe(1307)
    expect(worldAt(t, { branch: 1, tick: 640 })).toEqual(w)
    expect(worldAt(t, { branch: 1, tick: 620 })).toEqual(stepWorldTimes(truth[600]!, 20).world)
    expect(resolvePoint(t, 1, 590)).toEqual({ branch: 0, tick: 590 })
    expect(resolvePoint(t, 1, 700)).toEqual({ branch: 1, tick: 640 })
    expect(resolvePoint(t, 0, -Infinity)).toEqual({ branch: 0, tick: 0 })
    expect(resolvePoint(t, 7, 10)).toBeNull()
    expect(worldAt(t, { branch: 0, tick: 590 })).toEqual(truth[590]!)
  })

  test('the log at a time keeps the lines up to it', () => {
    const b = { ...startTimeline(groundWorld()).branches[0]!, log: [line(30.000000004, 'late'), line(30, 'now'), line(12, 'before')], commandLog: [{ tick: 300, callsign: null, command: AtcCommand.Pause() }, { tick: 120, callsign: null, command: AtcCommand.Pause() }] }
    expect(logAt(b, 30).map((l) => l.text)).toEqual(['late', 'now', 'before'])
    expect(logAt(b, 29.9).map((l) => l.text)).toEqual(['before'])
    expect(commandLogAt(b, 299).map((c) => c.tick)).toEqual([120])
  })
})

describe('layout', () => {
  test('lanes hang under their parents; the extent spans the furthest end and never less than a minute', () => {
    const { truth, timeline } = session()
    expect(extent(startTimeline(groundWorld()))).toEqual({ start: 0, end: MIN_EXTENT_STEPS })
    const t1 = resumeAt(timeline, { branch: 0, tick: 600 }, truth[600]!)!.timeline
    const t2 = resumeAt(t1, { branch: 0, tick: 200 }, truth[200]!)!.timeline
    const t3 = resumeAt(t2, { branch: 1, tick: 600 }, truth[600]!)!.timeline
    expect(lanes(t3).map((l) => [l.branch.id, l.row, l.depth])).toEqual([
      [0, 0, 0],
      [1, 1, 1],
      [2, 2, 1],
    ])
    expect(t3.branches).toHaveLength(3)
    expect(extent(t3)).toEqual({ start: 0, end: 1307 })
    expect(pointAt(t3, 0.5, 0.1)).toEqual({ branch: 0, tick: Math.round(1307 * 0.5) })
    expect(pointAt(t3, 0.5, 0.5)).toEqual({ branch: 1, tick: 600 })
    expect(pointAt(t3, 0.1, 0.5)).toEqual({ branch: 0, tick: Math.round(1307 * 0.1) })
    expect(pointAt(t3, 2, 2)).toEqual({ branch: 2, tick: 200 })
  })

  test('axis ticks pick a step that keeps about eight labels', () => {
    expect(axisTicks({ start: 0, end: 600 })).toEqual([0, 10, 20, 30, 40, 50, 60])
    expect(axisTicks({ start: 0, end: 6000 })).toEqual([0, 120, 240, 360, 480, 600])
    expect(axisTicks({ start: 0, end: 36000 })).toEqual([0, 600, 1200, 1800, 2400, 3000, 3600])
  })
})

describe('positions', () => {
  test('the seed rules do not matter to reconstruction', () => {
    const world = { ...groundWorld(GROUND_RULES), tick: 0 }
    const t = recordSteps(startTimeline(world), stepWorldTimes(world, 400).world)
    expect(worldAt(t, { branch: 0, tick: 400 })).toEqual(stepWorldTimes(world, 400).world)
  })
})
