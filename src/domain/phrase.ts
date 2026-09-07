/**
 * Phraseology as tokens (docs/REWRITE.md section 5, "Phraseology"). A Phrase is a
 * list of tokens; `written` renders it for the log and `spoken` for the voice.
 */
import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

export const PhraseToken = defineTaggedUnion({
  Text: { text: Schema.String },
  Runway: { name: Schema.String },
  Taxiways: { names: Schema.Array(Schema.String) },
  Gate: { name: Schema.String },
  Frequency: { value: Schema.String },
  Digits: { value: Schema.String },
  Callsign: { callsign: Schema.String },
  /** a fix or navaid: five-letter names are said as words, shorter ones spelled */
  Fix: { name: Schema.String },
})
export type PhraseToken = typeof PhraseToken.Type

export const Phrase = Schema.Array(PhraseToken)
export type Phrase = typeof Phrase.Type

export type PhrasePart = string | PhraseToken

/** Build a Phrase from strings (text) and tokens. */
export const phrase = (...parts: ReadonlyArray<PhrasePart>): Phrase =>
  parts.map((p) => (typeof p === 'string' ? PhraseToken.Text({ text: p }) : p))

export const runway = (name: string) => PhraseToken.Runway({ name })
export const taxiways = (names: ReadonlyArray<string>) => PhraseToken.Taxiways({ names })
export const gate = (name: string) => PhraseToken.Gate({ name })
export const frequency = (value: string) => PhraseToken.Frequency({ value })
export const digits = (value: string) => PhraseToken.Digits({ value })
export const callsign = (value: string) => PhraseToken.Callsign({ callsign: value })
export const fix = (name: string) => PhraseToken.Fix({ name })

// WORDS

export const TELEPHONY: Readonly<Record<string, string>> = {
  AAL: 'American', DAL: 'Delta', UAL: 'United', SWA: 'Southwest', SKW: 'SkyWest', EDV: 'Endeavor', RPA: 'Brickyard',
  ENY: 'Envoy', JBU: 'JetBlue', SCX: 'Sun Country', ASA: 'Alaska', NKS: 'Spirit', FFT: 'Frontier', FDX: 'FedEx', UPS: 'UPS',
  EJA: 'ExecJet', LXJ: 'Flexjet', JIA: 'Blue Streak', ASH: 'Air Shuttle', QXE: 'Horizon', AWI: 'Wisconsin', GJS: 'Lindbergh',
  PDT: 'Piedmont', CPZ: 'Compass', ACA: 'Air Canada', JZA: 'Jazz', WJA: 'WestJet', BAW: 'Speedbird', DLH: 'Lufthansa',
  AFR: 'Air France', KLM: 'KLM', UAE: 'Emirates', ICE: 'Ice Air', AAY: 'Allegiant', HAL: 'Hawaiian', MXY: 'Breeze',
  VRD: 'Redwood', AMX: 'Aeromexico', VIV: 'Viva', VOI: 'Volaris', CFG: 'Condor', VIR: 'Virgin', ABX: 'Abex', GTI: 'Giant',
  ATN: 'Air Transport', CKS: 'Connie', SWQ: 'Swift', BMJ: 'Bemidji', MTN: 'Mountain', LYM: 'Key Lime', JTL: 'Jet Linx',
}

export const NATO: Readonly<Record<string, string>> = {
  A: 'alpha', B: 'bravo', C: 'charlie', D: 'delta', E: 'echo', F: 'foxtrot', G: 'golf', H: 'hotel', I: 'india', J: 'juliet',
  K: 'kilo', L: 'lima', M: 'mike', N: 'november', O: 'oscar', P: 'papa', Q: 'quebec', R: 'romeo', S: 'sierra', T: 'tango',
  U: 'uniform', V: 'victor', W: 'whiskey', X: 'x-ray', Y: 'yankee', Z: 'zulu', 0: 'zero', 1: 'one', 2: 'two', 3: 'three',
  4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'niner',
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
const RUNWAY_SIDE: Readonly<Record<string, string>> = { L: 'left', R: 'right', C: 'center' }

/** Every character spelled: letters by ICAO alphabet, digits as words. */
export const spell = (s: string): string => [...s].map((c) => NATO[c] ?? c).join(' ')

/** Digit by digit: "4521" -> "four five two one". */
export const digitWords = (s: string | number): string => spell(String(s))

/** 0..99 as a number word: 47 -> "forty-seven". */
export const numberWords = (n: number): string =>
  n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? '-' + ONES[n % 10] : ''}`

/** Airline flight numbers in group form: 1047 "ten forty-seven", 894 "eight ninety-four", 1004 "ten zero four". */
export const groupNumber = (d: string): string => {
  const pair = (p: string) => (p === '00' ? 'hundred' : p[0] === '0' ? `zero ${ONES[+p[1]!]}` : numberWords(+p))
  if (d.length === 4) {
    return `${numberWords(+d.slice(0, 2))} ${pair(d.slice(2))}`
  }
  if (d.length === 3) {
    return `${ONES[+d[0]!]} ${pair(d.slice(1))}`
  }
  return numberWords(+d)
}

export const spokenCallsign = (cs: string): string => {
  const m = /^([A-Z]{3})(\d{1,4})([A-Z]{0,2})$/.exec(cs)
  const telephony = m ? TELEPHONY[m[1]!] : undefined
  if (m && telephony !== undefined) {
    return `${telephony} ${groupNumber(m[2]!)}${m[3] ? ' ' + spell(m[3]) : ''}`
  }
  if (/^N[0-9A-Z]+$/.test(cs)) {
    return spell(cs)
  }
  return m ? `${spell(m[1]!)} ${spell(m[2]!)}${m[3] ? ' ' + spell(m[3]) : ''}` : spell(cs)
}

/** "30L" -> "three zero left"; "12R-30L" -> "one two right, three zero left". */
export const spokenRunway = (t: string): string =>
  t
    .split('-')
    .map((p) => {
      const m = /^(\d{1,2})([LRC])?$/.exec(p)
      return m ? `${digitWords(m[1]!)}${m[2] ? ' ' + RUNWAY_SIDE[m[2]] : ''}` : spell(p)
    })
    .join(', ')

/** Short identifiers are spelled; a name of 5+ letters (ALLEY) is a word. */
export const spokenIdent = (t: string): string =>
  t
    .trim()
    .split(/\s+/)
    .map((x) => (/^[A-Z]{5,}$/.test(x) ? x.toLowerCase() : spell(x)))
    .join(', ')

/** "124.700" -> "one two four point seven". */
export const spokenFrequency = (t: string): string => {
  const [whole = '', frac = ''] = t.split('.')
  const trimmed = frac.replace(/0+$/, '') || '0'
  return `${digitWords(whole)} point ${digitWords(trimmed)}`
}

/** 5000 "five thousand", 17500 "one seven thousand five hundred", 23000 "flight level two three zero". */
export const altitudeWords = (alt: number): string => {
  if (alt >= 18000) {
    return `flight level ${digitWords(Math.round(alt / 100))}`
  }
  const thousands = Math.floor(alt / 1000)
  const hundreds = Math.round((alt % 1000) / 100)
  return `${thousands ? digitWords(thousands) + ' thousand' : ''}${hundreds ? ` ${NATO[hundreds]} hundred` : ''}`.trim()
}

// RENDERERS

const joinParts = (parts: ReadonlyArray<string>): string =>
  parts.reduce((out, part) => (out === '' ? part : /^[,.;:)]/.test(part) ? out + part : `${out} ${part}`), '')

const writtenToken = (token: PhraseToken): string =>
  PhraseToken.match(token, {
    Text: ({ text }) => text,
    Runway: ({ name }) => name,
    Taxiways: ({ names }) => names.join(' '),
    Gate: ({ name }) => name,
    Frequency: ({ value }) => value,
    Digits: ({ value }) => value,
    Callsign: ({ callsign }) => callsign,
    Fix: ({ name }) => name,
  })

const spokenToken = (token: PhraseToken): string =>
  PhraseToken.match(token, {
    Text: ({ text }) => text,
    Runway: ({ name }) => spokenRunway(name),
    Taxiways: ({ names }) => names.map(spokenIdent).join(', '),
    Gate: ({ name }) => spokenIdent(name),
    Frequency: ({ value }) => spokenFrequency(value),
    Digits: ({ value }) => digitWords(value),
    Callsign: ({ callsign }) => spokenCallsign(callsign),
    Fix: ({ name }) => spokenFix(name),
  })

/** MUSCL -> "Muscl" (a pronounceable name), GEP -> "golf echo papa", TORGY252018 spelled by parts. */
export const spokenFix = (name: string): string => {
  const m = /^([A-Z]{2,5})(\d{3})(\d{3})$/.exec(name)
  if (m !== null) {
    return `the ${spokenFix(m[1]!)} ${digitWords(m[2]!)} radial, ${numberWords(parseInt(m[3]!, 10))} mile fix`
  }
  return /^[A-Z]{5}$/.test(name) ? name[0]! + name.slice(1).toLowerCase() : spell(name)
}

export const written = (p: Phrase): string => joinParts(p.map(writtenToken))
export const spoken = (p: Phrase): string => joinParts(p.map(spokenToken))

/** Best effort for free text written without a spoken form (the AI's readback). */
export const spokenFreeText = (s: string): string => {
  const names = Object.values(TELEPHONY).join('|').replace(/ /g, '\\s')
  return s
    .replace(new RegExp(`\\b(${names})\\s+(\\d{1,4})([A-Z]{0,2})\\b`, 'g'), (_m, n: string, d: string, sfx: string) =>
      `${n} ${groupNumber(d)}${sfx ? ' ' + spell(sfx) : ''}`)
    .replace(/\b([A-Z]{3})(\d{1,4})([A-Z]{0,2})\b/g, (m) => spokenCallsign(m))
    .replace(/\bN(\d[0-9A-Z]{1,5})\b/g, (m) => spell(m))
    .replace(/\b(\d{3})\.(\d{1,3})\b/g, (m) => spokenFrequency(m))
    .replace(/\b(runway|rwy)\s+(\d{1,2}[LRC]?)\b/gi, (_m, _w, r: string) => `runway ${spokenRunway(r.toUpperCase())}`)
    .replace(/\b(\d{1,2})([LRC])\b/g, (_m, d: string, side: string) => `${digitWords(d)} ${RUNWAY_SIDE[side]}`)
    .replace(/\b(squawk(?:ing)?|heading)\s+(\d{3,4})\b/gi, (_m, w: string, d: string) => `${w} ${digitWords(d)}`)
    .replace(/\b(via|taxiway|short of|hold short|at|exit at|gate|spot)\s+((?:[A-Z]{1,2}\d{0,2}\b[\s,]*)+)/g,
      (_m, w: string, list: string) => `${w} ${list.replace(/\b([A-Z]{1,2}\d{0,2})\b/g, (t) => spell(t))}`)
}
