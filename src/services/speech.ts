/**
 * Pilot voices (docs/REWRITE.md section 5, "Audio"): the browser's
 * speechSynthesis, or OpenRouter speech decoded through Web Audio with a VHF-ish
 * filter, played one transmission at a time with fetches running ahead. A failed
 * OpenRouter utterance falls back to the browser voice and is reported once
 * through `events`.
 */
import { Context, Effect, Layer, PubSub, Ref, Stream } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'
import { Schema } from 'effect'

import { browserVoiceParams, pickProviderVoice } from '../domain/voices'
import { OpenRouter, type OpenRouterError } from './openRouter'

export type Utterance = Readonly<{
  callsign: string
  text: string
  engine: 'browser' | 'openrouter'
  key: string
  model: string
  /** chosen provider voice ('' = auto per callsign) */
  providerVoice: string
  /** chosen browser voice name ('' = auto per callsign) */
  browserVoice: string
  radio: boolean
}>

export const SpeechEvent = defineTaggedUnion({
  FellBack: { error: Schema.String },
})
export type SpeechEvent = typeof SpeechEvent.Type

export type BrowserVoice = Readonly<{ name: string; lang: string }>

export type SpeechShape = Readonly<{
  speak: (utterance: Utterance) => Effect.Effect<void>
  /** Fetch and play right now, outside the queue, failing on any error; for Settings → Test voice. */
  test: (utterance: Utterance) => Effect.Effect<number, Error>
  stop: Effect.Effect<void>
  browserVoices: Effect.Effect<ReadonlyArray<BrowserVoice>>
  /** provider voices per speech model, once `rememberSpeechModels` was called */
  rememberSpeechModels: (speech: Readonly<Record<string, ReadonlyArray<string> | null>>) => Effect.Effect<void>
  events: Stream.Stream<SpeechEvent>
}>

export class Speech extends Context.Service<Speech, SpeechShape>()('Speech') {}

export const TTS_CACHE_LIMIT = 200

const englishBrowserVoices = (): ReadonlyArray<SpeechSynthesisVoice> =>
  typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang))

/** Chrome drops an utterance that nothing references before it finishes; keep the live ones. */
const liveUtterances = new Set<SpeechSynthesisUtterance>()

const speakBrowser = (callsign: string, text: string, chosen: string): void => {
  if (typeof speechSynthesis === 'undefined') {
    return
  }
  const voices = englishBrowserVoices()
  const params = browserVoiceParams(callsign, voices.length)
  const utterance = new SpeechSynthesisUtterance(text)
  const voice = (chosen !== '' ? voices.find((v) => v.name === chosen) : undefined) ?? voices[params.index]
  if (voice !== undefined) {
    utterance.voice = voice
  }
  utterance.rate = params.rate
  utterance.pitch = params.pitch
  utterance.volume = 1
  liveUtterances.add(utterance)
  utterance.onend = () => liveUtterances.delete(utterance)
  utterance.onerror = (event) => {
    liveUtterances.delete(utterance)
    if (voice !== undefined && event.error !== 'interrupted' && event.error !== 'canceled') {
      const plain = new SpeechSynthesisUtterance(text)
      plain.rate = params.rate
      plain.pitch = params.pitch
      liveUtterances.add(plain)
      plain.onend = () => liveUtterances.delete(plain)
      plain.onerror = () => liveUtterances.delete(plain)
      speechSynthesis.speak(plain)
    }
  }
  speechSynthesis.speak(utterance)
}

/**
 * Browsers only let audio start from a user gesture. Commands run outside the
 * gesture, so the context is created and resumed synchronously on the first
 * pointer or key event instead; later Speak commands find it running.
 */
const unlockOnGesture = (unlock: () => void): void => {
  if (typeof document === 'undefined') {
    return
  }
  const once = () => {
    unlock()
    for (const type of GESTURES) {
      document.removeEventListener(type, once, true)
    }
  }
  for (const type of GESTURES) {
    document.addEventListener(type, once, true)
  }
}
const GESTURES = ['pointerdown', 'keydown', 'touchstart'] as const

/** VHF receiver: ~300-3000 Hz passband, a little grit, then squash the dynamics. */
const radioChain = (ac: AudioContext, source: AudioNode): AudioNode => {
  const hp = ac.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 320
  hp.Q.value = 0.9
  const lp = ac.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 3000
  lp.Q.value = 0.9
  const shaper = ac.createWaveShaper()
  const curve = new Float32Array(1024)
  for (let i = 0; i < 1024; i++) {
    const x = i / 511.5 - 1
    curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2)
  }
  shaper.curve = curve
  const comp = ac.createDynamicsCompressor()
  comp.threshold.value = -28
  comp.ratio.value = 8
  comp.attack.value = 0.003
  comp.release.value = 0.12
  const gain = ac.createGain()
  gain.gain.value = 1.25
  source.connect(hp)
  hp.connect(lp)
  lp.connect(shaper)
  shaper.connect(comp)
  comp.connect(gain)
  return gain
}

type Queued = Readonly<{ utterance: Utterance; audio: Promise<AudioBuffer> }>

export const SpeechBrowser = Layer.effect(Speech)(
  Effect.gen(function* () {
    const openRouter = yield* OpenRouter
    const events = yield* PubSub.unbounded<SpeechEvent>()
    const speechModels = yield* Ref.make<Readonly<Record<string, ReadonlyArray<string> | null>>>({})
    let context: AudioContext | null = null
    let playing: AudioBufferSourceNode | null = null
    let warned = false
    const queue: Array<Queued> = []
    let pumping = false
    const cache = new Map<string, Promise<AudioBuffer>>()

    const audioContext = (): AudioContext => {
      context ??= new AudioContext()
      if (context.state === 'suspended') {
        context.resume().catch(() => undefined)
      }
      return context
    }
    unlockOnGesture(() => {
      audioContext()
      if (typeof speechSynthesis !== 'undefined') {
        speechSynthesis.getVoices()
      }
    })

    /** Providers such as Kokoro need an explicit voice; learn the model's voices on first use. */
    const voiceFor = (u: Utterance): Effect.Effect<string | undefined> =>
      Effect.gen(function* () {
        const known = yield* Ref.get(speechModels)
        if (u.providerVoice !== '' || u.model in known) {
          return pickProviderVoice(u.callsign, known[u.model] ?? null, u.providerVoice)
        }
        const fetched = yield* openRouter.models(u.key).pipe(Effect.catch(() => Effect.succeed(null)))
        if (fetched !== null) {
          yield* Ref.set(speechModels, fetched.speech)
          return pickProviderVoice(u.callsign, fetched.speech[u.model] ?? null, u.providerVoice)
        }
        return undefined
      })

    const fetchSpeech = (u: Utterance, voice: string | undefined): Promise<AudioBuffer> => {
      const key = `${u.model}|${voice ?? ''}|${u.text}`
      const hit = cache.get(key)
      if (hit !== undefined) {
        return hit
      }
      const p = Effect.runPromise(openRouter.speech(u.key, u.model, u.text, voice)).then((bytes) => audioContext().decodeAudioData(bytes))
      cache.set(key, p)
      p.catch(() => cache.delete(key))
      if (cache.size > TTS_CACHE_LIMIT) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) {
          cache.delete(oldest)
        }
      }
      return p
    }

    const play = async (buffer: AudioBuffer, radio: boolean): Promise<void> => {
      const ac = audioContext()
      if (ac.state !== 'running') {
        await ac.resume().catch(() => undefined)
      }
      if (ac.state !== 'running') {
        throw new Error('audio output is blocked until you click or press a key on the page')
      }
      await new Promise<void>((resolve) => {
        const source = ac.createBufferSource()
        source.buffer = buffer
        const tail = radio ? radioChain(ac, source) : source
        tail.connect(ac.destination)
        playing = source
        const finish = () => {
          if (playing === source) {
            playing = null
          }
          resolve()
        }
        source.onended = finish
        setTimeout(finish, buffer.duration * 1000 + 1000)
        source.start()
      })
    }

    const pump = async (): Promise<void> => {
      if (pumping) {
        return
      }
      pumping = true
      while (queue.length > 0) {
        const item = queue.shift()!
        try {
          await play(await item.audio, item.utterance.radio)
        } catch (e) {
          if (!warned) {
            warned = true
            Effect.runSync(PubSub.publish(events, SpeechEvent.FellBack({ error: e instanceof Error ? e.message : String(e) })))
          }
          speakBrowser(item.utterance.callsign, item.utterance.text, item.utterance.browserVoice)
        }
      }
      pumping = false
    }

    return {
      speak: (u) =>
        Effect.gen(function* () {
          if (u.engine === 'openrouter' && u.key !== '') {
            const voice = yield* voiceFor(u)
            queue.push({ utterance: u, audio: fetchSpeech(u, voice) })
            void pump()
          } else {
            speakBrowser(u.callsign, u.text, u.browserVoice)
          }
        }),
      test: (u) =>
        Effect.gen(function* () {
          if (u.engine !== 'openrouter' || u.key === '') {
            speakBrowser(u.callsign, u.text, u.browserVoice)
            return 0
          }
          const voice = yield* voiceFor(u)
          const buffer = yield* Effect.tryPromise({ try: () => fetchSpeech(u, voice), catch: (e) => (e instanceof Error ? e : new Error(String(e))) })
          yield* Effect.tryPromise({ try: () => play(buffer, u.radio), catch: (e) => (e instanceof Error ? e : new Error(String(e))) })
          return buffer.duration
        }),
      stop: Effect.sync(() => {
        queue.length = 0
        if (playing !== null) {
          try {
            playing.stop()
          } catch {
            /* already stopped */
          }
          playing = null
        }
        if (typeof speechSynthesis !== 'undefined') {
          speechSynthesis.cancel()
        }
      }),
      browserVoices: Effect.sync(() => englishBrowserVoices().map((v) => ({ name: v.name, lang: v.lang }))),
      rememberSpeechModels: (speech) => Ref.set(speechModels, speech),
      events: Stream.fromPubSub(events),
    } satisfies SpeechShape
  }),
)

/** Records utterances for tests. */
export const SpeechRecording = (spoken: Array<Utterance>) =>
  Layer.succeed(Speech)({
    speak: (u) => Effect.sync(() => void spoken.push(u)),
    test: (u) => Effect.sync(() => {
      spoken.push(u)
      return 0
    }),
    stop: Effect.sync(() => void spoken.splice(0)),
    browserVoices: Effect.succeed([{ name: 'Test Voice', lang: 'en-US' }]),
    rememberSpeechModels: () => Effect.void,
    events: Stream.empty,
  })

export type { OpenRouterError }
