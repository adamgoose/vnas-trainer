/**
 * Keyless push-to-talk: the browser's SpeechRecognition, whose words are treated
 * as typed. Results arrive on `events`.
 */
import { Context, Effect, Layer, PubSub, Schema, Stream } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

export const RecognitionEvent = defineTaggedUnion({
  Heard: { text: Schema.String },
  Failed: { error: Schema.String },
  Ended: {},
})
export type RecognitionEvent = typeof RecognitionEvent.Type

export type RecognitionShape = Readonly<{
  available: boolean
  start: Effect.Effect<void, Error>
  stop: Effect.Effect<void>
  events: Stream.Stream<RecognitionEvent>
}>

export class Recognition extends Context.Service<Recognition, RecognitionShape>()('Recognition') {}

type SpeechRecognitionLike = {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

const constructor = (): (new () => SpeechRecognitionLike) | null => {
  const w = globalThis as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const RecognitionBrowser = Layer.effect(Recognition)(
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<RecognitionEvent>()
    const publish = (event: RecognitionEvent) => Effect.runSync(PubSub.publish(events, event))
    let active: SpeechRecognitionLike | null = null
    const Ctor = constructor()
    return {
      available: Ctor !== null,
      start: Effect.try({
        try: () => {
          if (Ctor === null) {
            throw new Error('no speech recognition in this browser')
          }
          const rec = new Ctor()
          rec.lang = 'en-US'
          rec.interimResults = false
          rec.maxAlternatives = 1
          rec.onresult = (e) => {
            const text = e.results[0]?.[0]?.transcript
            if (text) {
              publish(RecognitionEvent.Heard({ text }))
            }
          }
          rec.onerror = (e) => {
            if (e.error !== 'aborted' && e.error !== 'no-speech') {
              publish(RecognitionEvent.Failed({ error: e.error }))
            }
            active = null
            publish(RecognitionEvent.Ended())
          }
          rec.onend = () => {
            active = null
            publish(RecognitionEvent.Ended())
          }
          active = rec
          rec.start()
        },
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),
      stop: Effect.sync(() => {
        const rec = active
        active = null
        try {
          rec?.stop()
        } catch {
          /* already stopped */
        }
      }),
      events: Stream.fromPubSub(events),
    } satisfies RecognitionShape
  }),
)

export const RecognitionFake = (available: boolean) =>
  Layer.succeed(Recognition)({ available, start: Effect.void, stop: Effect.void, events: Stream.empty })
