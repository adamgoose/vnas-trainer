/**
 * The session's time graph: rewind, and resume at any point as a new branch.
 *
 * The sim is deterministic (the PRNG lives in the World), so the World at any
 * tick is a keyframe plus pure physics steps. Every change to the World that is
 * not a step (a command, the arrival generator, a position change) records a
 * keyframe, and a periodic keyframe every KEYFRAME_STEPS bounds the replay
 * between them. Stepped aircraft share references with the previous step, so a
 * keyframe costs little more than the aircraft that moved.
 *
 * A branch spans the ticks from where it left its parent to the last tick it
 * reached, and carries the log and command log of its whole path as they stood
 * at its end. Resuming somewhere before the end of a branch forks a new one
 * there; resuming at the end continues that branch.
 */
import { Schema } from 'effect'

import { SIM_STEP_S, stepWorldTimes } from '../domain/physics'
import { World } from '../domain/world'
import { CommandRecord, LogLine } from './log'

/** Periodic keyframe interval in physics steps (30 s of sim time); also the most steps rebuilding a tick takes. */
export const KEYFRAME_STEPS = 300

export const Keyframe = Schema.Struct({
  tick: Schema.Number,
  /** what changed the World here; null for the start and for periodic keyframes */
  label: Schema.NullOr(Schema.String),
  world: World,
})
export type Keyframe = typeof Keyframe.Type

export const Branch = Schema.Struct({
  id: Schema.Number,
  parent: Schema.NullOr(Schema.Number),
  /** the tick this branch left its parent at; the root starts where the scenario did */
  forkTick: Schema.Number,
  endTick: Schema.Number,
  /** ascending by tick; the first one sits at forkTick */
  keyframes: Schema.Array(Keyframe),
  /** the path's log as it stood at endTick; stale for the branch being extended live until it is parked */
  log: Schema.Array(LogLine),
  commandLog: Schema.Array(CommandRecord),
})
export type Branch = typeof Branch.Type

export const Timeline = Schema.Struct({
  branches: Schema.Array(Branch),
  /** the branch the live sim extends */
  current: Schema.Number,
})
export type Timeline = typeof Timeline.Type

/** A point of the graph being looked at instead of the present. */
export const Review = Schema.Struct({
  branch: Schema.Number,
  tick: Schema.Number,
  /** whether the sim was running when the rewind began; restored on Live or Resume */
  wasRunning: Schema.Boolean,
})
export type Review = typeof Review.Type

export type Point = Readonly<{ branch: number; tick: number }>

export const emptyTimeline: Timeline = { branches: [], current: 0 }

export const startTimeline = (world: World): Timeline => ({
  branches: [{ id: 0, parent: null, forkTick: world.tick, endTick: world.tick, keyframes: [{ tick: world.tick, label: null, world }], log: [], commandLog: [] }],
  current: 0,
})

export const branchOf = (timeline: Timeline, id: number): Branch | undefined => timeline.branches.find((b) => b.id === id)

export const currentBranch = (timeline: Timeline): Branch | undefined => branchOf(timeline, timeline.current)

/** The end of the branch being extended live, or null before a scenario has loaded. */
export const liveEnd = (timeline: Timeline): Point | null => {
  const b = currentBranch(timeline)
  return b === undefined ? null : { branch: b.id, tick: b.endTick }
}

const updateBranch = (timeline: Timeline, id: number, f: (b: Branch) => Branch): Timeline => ({
  ...timeline,
  branches: timeline.branches.map((b) => (b.id === id ? f(b) : b)),
})

/** A keyframe after a change that was not a step. One at the same tick as the last replaces it, the labels joined. */
export const recordChange = (timeline: Timeline, world: World, label: string): Timeline =>
  updateBranch(timeline, timeline.current, (b) => {
    const last = b.keyframes.at(-1)
    const keyframes =
      last !== undefined && last.tick === world.tick
        ? [...b.keyframes.slice(0, -1), { tick: world.tick, label: last.label === null ? label : `${last.label} · ${label}`, world }]
        : [...b.keyframes, { tick: world.tick, label, world }]
    return { ...b, endTick: Math.max(b.endTick, world.tick), keyframes }
  })

/** After physics steps: the branch end moves, and a periodic keyframe bounds the replay. */
export const recordSteps = (timeline: Timeline, world: World): Timeline =>
  updateBranch(timeline, timeline.current, (b) => {
    const last = b.keyframes.at(-1)
    const due = last === undefined || world.tick - last.tick >= KEYFRAME_STEPS
    return { ...b, endTick: Math.max(b.endTick, world.tick), keyframes: due ? [...b.keyframes, { tick: world.tick, label: null, world }] : b.keyframes }
  })

/** Store the live log and command log on the branch being extended, before the model shows another point. */
export const parkBranch = (timeline: Timeline, log: ReadonlyArray<LogLine>, commandLog: ReadonlyArray<CommandRecord>): Timeline =>
  updateBranch(timeline, timeline.current, (b) => ({ ...b, log, commandLog }))

/**
 * The branch whose span holds `tick` on the path down to `branch`, with the tick
 * clamped into the graph: before a branch's fork the path is its parent's.
 */
export const resolvePoint = (timeline: Timeline, branch: number, tick: number): Point | null => {
  let b = branchOf(timeline, branch)
  if (b === undefined) {
    return null
  }
  let at = Math.round(Math.min(tick, b.endTick))
  while (at < b.forkTick && b.parent !== null) {
    const parent = branchOf(timeline, b.parent)
    if (parent === undefined) {
      break
    }
    b = parent
  }
  return { branch: b.id, tick: Math.max(at, b.forkTick) }
}

export type WorldHint = Readonly<{ point: Point; world: World }>

/**
 * The World at a point: the last keyframe at or before it, stepped forward. A
 * hint (the World already shown, on the same branch and not past the point)
 * is stepped instead when that is fewer steps, which keeps scrubbing cheap.
 */
export const worldAt = (timeline: Timeline, point: Point, hint: WorldHint | null = null): World | null => {
  const b = branchOf(timeline, point.branch)
  if (b === undefined) {
    return null
  }
  let keyframe: Keyframe | undefined
  for (const k of b.keyframes) {
    if (k.tick <= point.tick) {
      keyframe = k
    }
  }
  const base = keyframe ?? b.keyframes[0]
  if (base === undefined) {
    return null
  }
  const fromKeyframe = Math.max(0, point.tick - base.tick)
  if (hint !== null && hint.point.branch === point.branch && hint.point.tick <= point.tick && hint.point.tick >= base.tick && point.tick - hint.point.tick < fromKeyframe) {
    return stepWorldTimes(hint.world, point.tick - hint.point.tick).world
  }
  return stepWorldTimes(base.world, fromKeyframe).world
}

const LOG_TIME_SLACK = 1e-6

/** The path's log read at a sim time: a branch's log begins as its parent's up to the fork, so its own lines are the whole path. */
export const logAt = (branch: Branch, simTime: number): ReadonlyArray<LogLine> => branch.log.filter((line) => line.time <= simTime + LOG_TIME_SLACK)

export const commandLogAt = (branch: Branch, tick: number): ReadonlyArray<CommandRecord> => branch.commandLog.filter((c) => c.tick <= tick)

export type Resumed = Readonly<{ timeline: Timeline; branch: Branch; forked: boolean }>

/**
 * Resume at a point: at the end of a branch that branch continues; anywhere
 * earlier a new branch forks there, starting from the World shown and the
 * path's log up to that moment.
 */
export const resumeAt = (timeline: Timeline, point: Point, world: World): Resumed | null => {
  const b = branchOf(timeline, point.branch)
  if (b === undefined) {
    return null
  }
  if (point.tick >= b.endTick) {
    return { timeline: { ...timeline, current: b.id }, branch: b, forked: false }
  }
  const id = timeline.branches.reduce((max, x) => Math.max(max, x.id), -1) + 1
  const branch: Branch = {
    id,
    parent: b.id,
    forkTick: point.tick,
    endTick: point.tick,
    keyframes: [{ tick: point.tick, label: null, world }],
    log: logAt(b, world.simTime),
    commandLog: commandLogAt(b, point.tick),
  }
  return { timeline: { branches: [...timeline.branches, branch], current: id }, branch, forked: true }
}

// LAYOUT (shared by the view and the pointer hit test)

export type Lane = Readonly<{ branch: Branch; row: number; depth: number }>

/** Branches in display order: depth first from the root, so a fork sits under its parent. */
export const lanes = (timeline: Timeline): ReadonlyArray<Lane> => {
  const out: Array<Lane> = []
  const visit = (parent: number | null, depth: number): void => {
    for (const b of timeline.branches.filter((x) => x.parent === parent)) {
      out.push({ branch: b, row: out.length, depth })
      visit(b.id, depth + 1)
    }
  }
  visit(null, 0)
  return out
}

/** The track never shows less than this much sim time, so an early session still has a scale. */
export const MIN_EXTENT_STEPS = 600

export type Extent = Readonly<{ start: number; end: number }>

/** The ticks the track spans: from the root's start to the furthest branch end. */
export const extent = (timeline: Timeline): Extent => {
  const start = timeline.branches.reduce((min, b) => Math.min(min, b.forkTick), Infinity)
  const end = timeline.branches.reduce((max, b) => Math.max(max, b.endTick), -Infinity)
  return Number.isFinite(start) ? { start, end: Math.max(end, start + MIN_EXTENT_STEPS) } : { start: 0, end: MIN_EXTENT_STEPS }
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))

/** The point under a press at fractions of the lanes area: the lane by row, the tick by position along the track. */
export const pointAt = (timeline: Timeline, fx: number, fy: number): Point | null => {
  const all = lanes(timeline)
  if (all.length === 0) {
    return null
  }
  const lane = all[Math.min(all.length - 1, Math.floor(clamp01(fy) * all.length))]!
  const { start, end } = extent(timeline)
  return resolvePoint(timeline, lane.branch.id, start + clamp01(fx) * (end - start))
}

export const AXIS_STEPS_S: ReadonlyArray<number> = [10, 30, 60, 120, 300, 600, 900, 1800, 3600]

/** Gridline sim times for the track: the smallest step that keeps the labels to about eight. */
export const axisTicks = (e: Extent): ReadonlyArray<number> => {
  const spanS = (e.end - e.start) * SIM_STEP_S
  const step = AXIS_STEPS_S.find((s) => spanS / s <= 8) ?? AXIS_STEPS_S[AXIS_STEPS_S.length - 1]!
  const startS = e.start * SIM_STEP_S
  const first = Math.ceil(startS / step) * step
  const out: Array<number> = []
  for (let t = first; t <= startS + spanS + 1e-9; t += step) {
    out.push(t)
  }
  return out
}
