import { readFileSync } from 'node:fs'

import type { Aircraft } from '../src/domain/aircraft'
import { type AirportFile, decodeAirportFile } from '../src/domain/catalog'
import { AtcCommand, executeCommand, parseCommandLine } from '../src/domain/commands'
import { written } from '../src/domain/phrase'
import { stepWorld } from '../src/domain/physics'
import { GROUND_RULES, type PositionRules } from '../src/domain/rules'
import { loadScenario } from '../src/domain/scenario'
import { type SimEvent, type World, findAircraft, makeWorld } from '../src/domain/world'

export const loadMsp = (): AirportFile =>
  decodeAirportFile(JSON.parse(readFileSync(new URL('./fixtures/MSP.json', import.meta.url), 'utf8')))

export const msp = loadMsp()

export const scenarioNamed = (name: string) => {
  const s = msp.scen.find((x) => x.name === name)
  if (s === undefined) {
    throw new Error(`no scenario ${name}`)
  }
  return s
}

/** The scenario that places `callsign` with spawn kind `kind`. */
export const scenarioPlacing = (callsign: string, kind: 'P' | 'R' | 'F') => {
  const s = msp.scen.find((x) => x.ac.some((a) => a.cs === callsign && a.k === kind))
  if (s === undefined) {
    throw new Error(`no scenario places ${callsign} as ${kind}`)
  }
  return s
}

/** The big ground scenario: 82 parked aircraft, AAL894 at E16. */
export const groundWorld = (rules: PositionRules = GROUND_RULES, seed = 1): World =>
  loadScenario(makeWorld(msp, rules, seed), scenarioNamed('KMSP 12s/17 SLCL 5MIT')).world

export const emptyWorld = (rules: PositionRules = GROUND_RULES, seed = 1): World =>
  loadScenario(makeWorld(msp, rules, seed), null).world

export type Run = Readonly<{ world: World; events: ReadonlyArray<SimEvent>; seconds: number }>

/** Step for `seconds` of sim time. */
export const run = (world: World, seconds: number): Run => {
  let current = world
  const events: Array<SimEvent> = []
  const steps = Math.round(seconds * 10)
  for (let i = 0; i < steps; i++) {
    const out = stepWorld(current)
    current = out.world
    events.push(...out.events)
  }
  return { world: current, events, seconds }
}

/** Step until `done` holds, or fail after `maxSeconds`. */
export const runUntil = (world: World, done: (w: World) => boolean, maxSeconds: number): Run => {
  let current = world
  const events: Array<SimEvent> = []
  const steps = Math.round(maxSeconds * 10)
  for (let i = 0; i < steps; i++) {
    if (done(current)) {
      return { world: current, events, seconds: i / 10 }
    }
    const out = stepWorld(current)
    current = out.world
    events.push(...out.events)
  }
  throw new Error(`condition not met within ${maxSeconds}s`)
}

export const aircraftNamed = (world: World, callsign: string): Aircraft => {
  const a = findAircraft(world, callsign)
  if (a === undefined) {
    throw new Error(`no aircraft ${callsign}`)
  }
  return a
}

export const stateOf = (callsign: string, state: Aircraft['state']) => (w: World) =>
  findAircraft(w, callsign)?.state === state

/** Type a command line the way the app does; throws on a refusal. */
export const command = (world: World, text: string, selected: string | null = null): Readonly<{ world: World; events: ReadonlyArray<SimEvent>; callsign: string | null }> => {
  const parsed = parseCommandLine(world, selected, text)
  if (parsed._tag !== 'Parsed') {
    throw new Error(`"${text}" did not parse: ${JSON.stringify(parsed)}`)
  }
  const out = executeCommand(world, parsed.callsign, parsed.command)
  if ('error' in out) {
    throw new Error(`"${text}" refused: ${out.error}`)
  }
  return { ...out, callsign: parsed.callsign }
}

/** Like `command` but returns the refusal instead of throwing. */
export const refusal = (world: World, text: string, selected: string | null = null): string | null => {
  const parsed = parseCommandLine(world, selected, text)
  if (parsed._tag === 'Invalid') {
    return parsed.error
  }
  if (parsed._tag !== 'Parsed') {
    return `parse ${parsed._tag}`
  }
  const out = executeCommand(world, parsed.callsign, parsed.command)
  return 'error' in out ? out.error : null
}

export const pilotLines = (events: ReadonlyArray<SimEvent>): ReadonlyArray<string> =>
  events.flatMap((e) => (e._tag === 'PilotSaid' ? [`${e.callsign}: ${written(e.phrase)}`] : []))

export const systemLines = (events: ReadonlyArray<SimEvent>): ReadonlyArray<string> =>
  events.flatMap((e) => (e._tag === 'SystemNote' ? [e.text] : e._tag === 'Removed' ? [e.text] : []))

export { AtcCommand }
