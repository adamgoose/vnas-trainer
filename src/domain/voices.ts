/**
 * Voice picking (docs/REWRITE.md section 5, "Audio"): a per-callsign hash chooses
 * a stable voice, rate and pitch; provider voice lists are filtered to plain
 * English, professional voices.
 */
export const callsignHash = (callsign: string): number => [...callsign].reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 7)

/** Voices that are plainly English, when the provider encodes language in the name. */
export const englishVoices = (list: ReadonlyArray<string>): ReadonlyArray<string> => {
  const en = list.filter((v) => /(^|[-_])(en|gb|us)([-_]|$)|^(af|am|bf|bm)_|^English_/i.test(v))
  return en.length > 0 ? en : list
}

const VANITY =
  /whisper|sing|seduc|upset|sad|angry|frustrat|excit|cheer|happy|sarcas|confus|shame|jealous|curious|playful|santa|radiant|magnetic|captivat|compelling|graceful|expressive|narrator|aussie|bloke|girl|boy|kid|child|teen|elf|robot|monster|witch|ghost|pirate|cowboy|fear|scared|cry|laugh|drunk|sleepy|asmr|passionate|warrior|queen|king|prince|anime|comedian|whimsical|lovely|sentimental|stress|bossy|imposing|soft-spoken|storyteller|jovial|partner|strong-willed|debat|kind-hearted|upbeat|^none$/i
const EMOTION_SUFFIX = /_(neutral|sad|happy|angry|frustrated|excited|confident|cheerful|curious|sarcasm|confused|shameful|jealousy|calm|serious|surprised|disgusted|fearful)$/i

/** No singing, whispering, sulking or Santa on frequency: keep the plain, professional voices. */
export const professionalVoices = (list: ReadonlyArray<string>): ReadonlyArray<string> => {
  const out = list.filter((v) => !VANITY.test(v) && (!EMOTION_SUFFIX.test(v) || /_neutral$/i.test(v)))
  return out.length > 0 ? out : list
}

/** The chosen voice, else a stable pick per callsign from the model's list, else undefined (provider default). */
export const pickProviderVoice = (callsign: string, voices: ReadonlyArray<string> | null, chosen: string): string | undefined => {
  if (chosen !== '') {
    return chosen
  }
  if (voices === null || voices.length === 0) {
    return undefined
  }
  const en = professionalVoices(englishVoices(voices))
  return en[callsignHash(callsign) % en.length]
}

export type BrowserVoiceParams = Readonly<{ index: number; rate: number; pitch: number }>

/** Per-callsign browser voice: index into the English voice list, with a slight rate and pitch spread. */
export const browserVoiceParams = (callsign: string, voiceCount: number): BrowserVoiceParams => {
  const h = callsignHash(callsign)
  return {
    index: voiceCount > 0 ? h % voiceCount : 0,
    rate: 1.05 + ((h >> 4) % 3) * 0.06,
    pitch: 0.85 + ((h >> 8) % 6) * 0.06,
  }
}
