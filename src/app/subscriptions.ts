import { Clock, Effect, Option, Schema, Stream } from 'effect'
import { Subscription } from 'foldkit'

import { parseDeepLink } from './commands'
import type { SessionEvent } from '../domain/session'
import { Message } from './message'
import { type Model } from './model'
import { SIM_STEP_S } from '../domain/physics'
import { StarsMessage } from '../positions/local/stars'
import type { Microphone } from '../services/microphone'
import type { OpenRouter } from '../services/openRouter'
import { Recognition, RecognitionEvent } from '../services/recognition'
import type { SettingsStore } from '../services/settings'
import { Session, SessionIncoming } from '../services/session'
import { Speech, SpeechEvent } from '../services/speech'
import type { VideoMaps } from '../services/videoMaps'
import type { VnasData } from '../services/vnasData'

export const TICK_MS = SIM_STEP_S * 1000

export type Services = VnasData | VideoMaps | SettingsStore | OpenRouter | Speech | Microphone | Recognition | Session

const isTyping = (): boolean => {
  const el = globalThis.document?.activeElement
  return el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
}

export const subscriptions = Subscription.make<Model, Message, Services>()((entry) => ({
  tick: entry(
    { isActive: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isActive: model.running && model.airport._tag === 'Ready' && model.session.role !== 'guest' }),
      dependenciesToStream: ({ isActive }) =>
        isActive
          ? Stream.tick(`${TICK_MS} millis`).pipe(
              Stream.mapEffect(() => Clock.currentTimeMillis),
              Stream.map((now) => Message.Ticked({ now })),
            )
          : Stream.empty,
    },
  ),
  deepLink: Subscription.persistent(
    Subscription.fromEvent<HashChangeEvent, Message>({
      target: () => globalThis.window,
      type: 'hashchange',
      toMessage: () => Message.ChangedDeepLink(parseDeepLink(globalThis.location.hash)),
    }),
  ),
  /** while the STARS MAPS panel is open, a pointer down anywhere outside it (or its button) closes it */
  mapsOutside: entry(
    { open: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ open: model.stars.mapsOpen }),
      dependenciesToStream: ({ open }) =>
        open
          ? Subscription.fromEventFilterMap<PointerEvent, Message>({
              target: () => globalThis.document,
              type: 'pointerdown',
              toMessage: (event) =>
                event.target instanceof Element && event.target.closest('.smaps, .smaps-btn') !== null
                  ? Option.none()
                  : Option.some(Message.GotStars({ message: StarsMessage.PressedOutsideMaps() })),
            })
          : Stream.empty,
    },
  ),
  keys: entry(
    { dialogOpen: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ dialogOpen: model.dialog !== 'none' }),
      dependenciesToStream: ({ dialogOpen }) =>
        Subscription.fromEventFilterMap<KeyboardEvent, Message>({
          target: () => globalThis.document,
          type: 'keydown',
          toMessage: (event) => {
            if (event.key === '/' && !dialogOpen && !isTyping()) {
              event.preventDefault()
              return Option.some(Message.PressedSlash())
            }
            if (event.key === 'Escape' && isTyping()) {
              return Option.some(Message.PressedEscape())
            }
            if (event.key === ' ' && !event.repeat && !dialogOpen && !isTyping()) {
              event.preventDefault()
              return Option.some(Message.PressedPtt())
            }
            return Option.none()
          },
        }),
    },
  ),
  pttRelease: Subscription.persistent(
    Stream.merge(
      Subscription.fromEventFilterMap<KeyboardEvent, Message>({
        target: () => globalThis.document,
        type: 'keyup',
        toMessage: (event) => (event.key === ' ' ? Option.some(Message.ReleasedPtt()) : Option.none()),
      }),
      Subscription.fromEvent<Event, Message>({ target: () => globalThis.window, type: 'blur', toMessage: () => Message.ReleasedPtt() }),
    ),
  ),
  speechEvents: Subscription.persistent(
    Stream.unwrap(
      Effect.map(Speech, (speech) =>
        speech.events.pipe(Stream.map((event) => SpeechEvent.match(event, { FellBack: ({ error }) => Message.ReportedSpeechFallback({ error }) }))),
      ),
    ),
  ),
  sessionEvents: Subscription.persistent(
    Stream.unwrap(
      Effect.map(Session, (session) =>
        session.events.pipe(
          Stream.map((event) =>
            SessionIncoming.match<Message>(event, {
              PeerJoined: ({ peerId }) => Message.PeerJoined({ peerId }),
              PeerLeft: ({ peerId }) => Message.PeerLeft({ peerId }),
              Received: ({ peerId, event: received }) => Message.ReceivedSession({ peerId, event: received as SessionEvent }),
              JoinFailed: ({ error }) => Message.FailedSession({ error }),
            }),
          ),
        ),
      ),
    ),
  ),
  recognitionEvents: Subscription.persistent(
    Stream.unwrap(
      Effect.map(Recognition, (recognition) =>
        recognition.events.pipe(
          Stream.map((event) =>
            RecognitionEvent.match<Message>(event, {
              Heard: ({ text }) => Message.HeardRecognition({ text }),
              Failed: ({ error }) => Message.FailedRecognition({ error }),
              Ended: () => Message.EndedRecognition(),
            }),
          ),
        ),
      ),
    ),
  ),
}))
