/**
 * The plain-English bridge (docs/REWRITE.md section 5, "AI translation"): the
 * system and user prompts for OpenRouter, and the parser for its JSON reply.
 * Pure; the positions contribute their label.
 */
import { Schema } from 'effect'

import { TELEPHONY, spell, spokenRunway } from './phrase'
import type { World } from './world'

export const COMMAND_REFERENCE = `PUSH [taxiway] | TAXI <taxiways...> [HS <pt>] | RWY <runway> TAXI <taxiways...> |
HS <pt> | CROSS | RES | HOLD | BREAK | GIVEWAY <callsign> | LUAW | CTO | EXIT |
CTL (cleared to land) | GA (go around) | CD (contact departure / frequency change) |
FH <hdg> (fly heading) | TL <hdg> | TR <hdg> (turn left/right heading) | CM <alt> (climb/descend and maintain, feet or FL) |
TRACK (start radar track) | DROP | SQ <code> | SN | SS | ID | SAY <gate|type|rwy> | DEL | TAXIALL`

export type Prompt = Readonly<{ system: string; user: string }>

export type PromptInput = Readonly<{
  world: World
  airportName: string
  positionLabel: string
  selected: string | null
  audio: boolean
}>

const ROSTER_LIMIT = 60
const GATE_LIMIT = 40

export const buildPrompt = ({ world, airportName, positionLabel, selected, audio }: PromptInput): Prompt => {
  const onFrequency = world.aircraft.filter((a) => a.delay <= 0)
  const roster = onFrequency
    .slice(0, ROSTER_LIMIT)
    .map((a) => `${a.callsign} (${a.type}) ${a.state}${a.gate !== null ? ` gate ${a.gate}` : ''}${a.runway !== null ? ` rwy ${a.runway}` : ''}`)
    .join('; ')
  const gates = Object.keys(world.graph.parking)
  const taxiways = Object.keys(world.graph.taxiways)
  const taxiwayList = taxiways.map((t) => (/^[A-Z]{1,2}\d{0,2}$/.test(t) ? `${t} (${spell(t)})` : t)).join(', ') || 'none'
  const runwayList = Object.keys(world.graph.runwayEnds)
    .map((r) => `${r} (${spokenRunway(r)})`)
    .join(', ')
  const telephony = Object.entries(TELEPHONY)
    .filter(([prefix]) => onFrequency.some((a) => a.callsign.startsWith(prefix)))
    .map(([prefix, name]) => `${name} = ${prefix}`)
    .join(', ')
  const dep = world.airport.departure
  const system = `You are the pilot side of an air traffic control simulator at ${airportName} (${world.airport.id}).
The controller is working the ${positionLabel} position. Translate one controller transmission into ATCTrainer commands and produce the pilot's readback.

COMMANDS: ${COMMAND_REFERENCE}

THIS AIRPORT
Runways: ${runwayList}
Taxiways: ${taxiwayList}
Gates and spots (${gates.length}): ${gates.slice(0, GATE_LIMIT).join(' ')}${gates.length > GATE_LIMIT ? ' …' : ''}
${dep !== null ? `Departure frequency: ${dep.freq ?? ''} (${dep.radio})` : ''}

PHRASEOLOGY — how the controller talks, and what it maps to
- Letters are the ICAO alphabet (alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey x-ray yankee zulu). Numbers are spoken digit by digit: "niner" = 9, "tree" = 3, "fife" = 5.
- Runways: "runway one two left" = 12L, "runway three zero right" = 30R, "runway four" = 4. Taxiways: "alpha" = A, "alpha one" = A1, "kilo ten" = K10 — resolve against the taxiway list above; a taxiway name that is a word (ALLEY) is said as a word.
- Callsigns: airline telephony plus the flight number in COMBINED group form, never digit by digit — "Delta ten forty-seven" = DAL1047, "FedEx nineteen ninety-two" = FDX1992, "American eight ninety-four" = AAL894, "SkyWest thirty-five twenty-one" = SKW3521, "Southwest twelve hundred" = SWA1200, "Delta ten" = DAL10. GA aircraft are spelled: "November four two sierra tango" = N42ST, often shortened to the last three ("four two sierra tango" or "two sierra tango"). Always pick the matching callsign from the roster, never invent one.${telephony ? `\n  Telephony on frequency now: ${telephony}.` : ''}
- Ground: "push back approved" → PUSH; "push back approved, tail east onto alpha" → PUSH A; "runway three zero left, taxi via quebec, charlie" → RWY 30L TAXI Q C; "taxi to gate echo one six via bravo" → TAXI B E16; "hold short of runway one two right" as part of a taxi → append HS 12R to that taxi command, on its own → HS 12R; "cross runway one two right" → CROSS; "continue taxi" / "resume" → RES; "hold position" / "stop" → HOLD; "give way to the Delta seven thirty-seven" → GIVEWAY <that callsign>; "expedite" → BREAK; "monitor tower" / "contact ground" → no command, readback only.
- Tower: "line up and wait" → LUAW; "cleared for takeoff" → CTO; "cleared to land" → CTL; "go around" → GA; "fly heading zero niner zero" → FH 090; "turn left/right heading two seven zero" → TL 270 / TR 270; "climb and maintain five thousand" → CM 5000; "climb and maintain flight level two three zero" → CM FL230; "contact departure" → CD; "exit at alpha five" → EXIT A5.
- Transponder: "squawk four five two one" → SQ 4521; "ident" → ID; "squawk standby" → SS; "squawk normal" → SN.
- Several instructions in one transmission are several commands, in the order spoken. A transmission that is only a callsign check-in, an acknowledgement, or addressed to nobody in the roster produces no commands.
${
  audio
    ? `
AUDIO: the attached recording is the controller's push-to-talk transmission over a VHF radio — it may be clipped, fast, or noisy. Use the roster and the identifier lists above to resolve anything ambiguous (a taxiway you cannot hear clearly is one that exists here). Do not transcribe what is not there; if nothing usable was said, return no commands and say so in the readback.
`
    : ''
}
READBACK RULES
- "readback": the pilot's readback in standard WRITTEN phraseology with written identifiers, e.g. "Runway 30L, taxi via Q C, hold short 12R, Delta 1047". Read back the instruction, not a commentary. End with the callsign (written form).
- "spoken": the exact words for text-to-speech, every identifier spelled out: runways as digits plus left/right/center ("runway three zero left"), taxiways in the ICAO alphabet ("quebec, charlie"), gates likewise ("echo one six"), headings, squawk codes and beacon codes digit by digit using "niner", altitudes as "five thousand" / "flight level two three zero", frequencies as digits with "point" ("one two four point seven"), the callsign in telephony with the combined flight number ("Delta ten forty-seven", "FedEx nineteen ninety-two" — not "one nine nine two") — never leave a bare abbreviation like "30L" or "Q" in the spoken text.

Reply with ONLY a JSON object:
{${audio ? '"transcript":"<what the controller said, in standard written phraseology with written identifiers, e.g. DAL1047, runway 30L, taxi via Q C, hold short 12R>",\n ' : ''}"callsign":"<exact callsign from the roster, or null>",
 "commands":["<command line>", ...],
 "readback":"<written readback>",
 "spoken":"<spoken readback>"}`
  const user = `AIRCRAFT ON FREQUENCY: ${roster || 'none'}
CURRENTLY SELECTED: ${selected ?? 'none'}`
  return { system, user }
}

// REPLY

export const Translation = Schema.Struct({
  transcript: Schema.NullOr(Schema.String),
  callsign: Schema.NullOr(Schema.String),
  commands: Schema.Array(Schema.String),
  readback: Schema.NullOr(Schema.String),
  spoken: Schema.NullOr(Schema.String),
})
export type Translation = typeof Translation.Type

/** JSON from a model reply that may be fenced or wrapped in prose. */
export const parseJsonish = (text: string): unknown => {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  try {
    return JSON.parse(trimmed)
  } catch {
    const m = /\{[\s\S]*\}/.exec(trimmed)
    if (m !== null) {
      return JSON.parse(m[0])
    }
    throw new Error('no JSON in reply')
  }
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

/** Lenient: missing fields become null or empty; anything else is an error. */
export const parseTranslation = (text: string): Translation => {
  const json = parseJsonish(text)
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('reply is not an object')
  }
  const o = json as Record<string, unknown>
  const commands = Array.isArray(o['commands']) ? o['commands'].filter((c): c is string => typeof c === 'string' && c.trim() !== '') : []
  return {
    transcript: asString(o['transcript']),
    callsign: asString(o['callsign']),
    commands,
    readback: asString(o['readback']),
    spoken: asString(o['spoken']),
  }
}
