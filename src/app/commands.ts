/**
 * Everything that touches the outside world: catalog and vNAS data, video maps,
 * settings storage, the URL hash, focus, and the scope surface Mount that reports
 * its size and wheel events.
 */
import { Effect, Queue, Schema, Stream } from 'effect'
import { Command, Dom, Mount } from 'foldkit'

import { storeVideoMap } from './mapCache'
import { Message } from './message'
import { parseTranslation } from '../domain/prompt'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, SessionEvent, normaliseRoomCode } from '../domain/session'
import { Session, TurnServer } from '../services/session'
import { Microphone } from '../services/microphone'
import { OpenRouter } from '../services/openRouter'
import { Recognition } from '../services/recognition'
import { Settings, SettingsStore } from '../services/settings'
import { Speech } from '../services/speech'
import { VideoMaps } from '../services/videoMaps'
import { DataSource, VnasData } from '../services/vnasData'

export const LoadSettings = Command.define('LoadSettings', {
  messages: [Message.CompletedLoadSettings],
  execute: Effect.gen(function* () {
    const store = yield* SettingsStore
    return Message.CompletedLoadSettings({ settings: yield* store.load })
  }),
})

export const SaveSettings = Command.define('SaveSettings', {
  args: { settings: Settings },
  messages: [Message.CompletedSaveSettings],
  execute: ({ settings }) =>
    Effect.gen(function* () {
      const store = yield* SettingsStore
      yield* store.save(settings)
      return Message.CompletedSaveSettings()
    }),
})

export const parseDeepLink = (hash: string): Readonly<{ airport: string | null; scenario: string | null; room: string | null }> => {
  const [first = '', second = ''] = hash.replace(/^#/, '').split('/')
  if (first.toLowerCase() === 'join') {
    return { airport: null, scenario: null, room: normaliseRoomCode(second) || null }
  }
  return { airport: first.toUpperCase() || null, scenario: second || null, room: null }
}

export const ReadDeepLink = Command.define('ReadDeepLink', {
  messages: [Message.CompletedReadDeepLink],
  execute: Effect.sync(() => Message.CompletedReadDeepLink(parseDeepLink(globalThis.location?.hash ?? ''))),
})

export const ReplaceDeepLink = Command.define('ReplaceDeepLink', {
  args: { airport: Schema.String, scenario: Schema.NullOr(Schema.String) },
  messages: [Message.CompletedReplaceDeepLink],
  execute: ({ airport, scenario }) =>
    Effect.sync(() => {
      globalThis.history?.replaceState(null, '', `#${airport}${scenario !== null ? '/' + scenario : ''}`)
      return Message.CompletedReplaceDeepLink()
    }),
})

export const LoadIndex = Command.define('LoadIndex', {
  args: { source: DataSource },
  messages: [Message.CompletedLoadIndex, Message.FailedLoadIndex],
  execute: ({ source }) =>
    Effect.gen(function* () {
      const data = yield* VnasData
      return Message.CompletedLoadIndex({ index: yield* data.index(source) })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.FailedLoadIndex({ error: e.message })))),
})

export const LoadAirport = Command.define('LoadAirport', {
  args: { source: DataSource, id: Schema.String, artcc: Schema.String },
  messages: [Message.CompletedLoadAirport, Message.FailedLoadAirport],
  execute: ({ source, id, artcc }) =>
    Effect.gen(function* () {
      const data = yield* VnasData
      return Message.CompletedLoadAirport({ airport: yield* data.airport(source, id, artcc) })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.FailedLoadAirport({ id, error: e.message })))),
})

export const LoadScenario = Command.define('LoadScenario', {
  args: { source: DataSource, airportId: Schema.String, scenarioId: Schema.String },
  messages: [Message.CompletedLoadScenario, Message.FailedLoadScenario],
  execute: ({ source, airportId, scenarioId }) =>
    Effect.gen(function* () {
      const data = yield* VnasData
      return Message.CompletedLoadScenario({ airportId, scenario: yield* data.scenario(source, airportId, scenarioId) })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.FailedLoadScenario({ error: e.message })))),
})

export const LoadPavement = Command.define('LoadPavement', {
  args: { artcc: Schema.String, id: Schema.String, asdex: Schema.Boolean },
  messages: [Message.CompletedLoadPavement, Message.FailedLoadPavement],
  execute: ({ artcc, id, asdex }) =>
    Effect.gen(function* () {
      const maps = yield* VideoMaps
      const map = yield* maps.load(artcc, id)
      storeVideoMap(map)
      return Message.CompletedLoadPavement({ id, asdex })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.FailedLoadPavement({ error: e.message })))),
})

export const COMMAND_INPUT = '#cmd'

export const FocusCommand = Command.define('FocusCommand', {
  messages: [Message.CompletedFocusCommand],
  execute: Dom.focus(COMMAND_INPUT).pipe(
    Effect.map(() => Message.CompletedFocusCommand()),
    Effect.catch(() => Effect.succeed(Message.CompletedFocusCommand())),
  ),
})

export const BlurCommand = Command.define('BlurCommand', {
  messages: [Message.CompletedBlurCommand],
  execute: Effect.sync(() => {
    const active = globalThis.document?.activeElement
    if (active instanceof HTMLElement && active.matches(COMMAND_INPUT)) {
      active.blur()
    }
    return Message.CompletedBlurCommand()
  }),
})

/**
 * The ground scope container: reports its CSS size (and the device pixel ratio)
 * whenever it changes, and wheel events with their deltas, which Foldkit's
 * `OnWheel` attribute does not carry. Wheel events are non-passive so the page
 * never scrolls while zooming.
 */
type ScopeMessage = ReturnType<typeof Message.ResizedScope> | ReturnType<typeof Message.WheeledScope>

export const ScopeSurface = Mount.defineStream('ScopeSurface', {
  messages: [Message.ResizedScope, Message.WheeledScope],
  execute: ({ element }) => {
    const sizes = Stream.callback<ScopeMessage>((queue) =>
      Effect.gen(function* () {
        const report = () => {
          const rect = element.getBoundingClientRect()
          Effect.runSync(
            Queue.offer(
              queue,
              Message.ResizedScope({ width: Math.round(rect.width), height: Math.round(rect.height), devicePixelRatio: globalThis.devicePixelRatio ?? 1 }),
            ),
          )
        }
        const observer = new ResizeObserver(report)
        observer.observe(element)
        report()
        yield* Effect.addFinalizer(() => Effect.sync(() => observer.disconnect()))
      }),
    )
    const wheels = Stream.fromEventListener<WheelEvent>(element, 'wheel', { passive: false }).pipe(
      Stream.map((event): ScopeMessage => {
        event.preventDefault()
        const rect = element.getBoundingClientRect()
        return Message.WheeledScope({ x: event.clientX - rect.left, y: event.clientY - rect.top, deltaY: event.deltaY })
      }),
    )
    return Stream.merge(sizes, wheels)
  },
})

// AUDIO AND AI

export const StartRecording = Command.define('StartRecording', {
  messages: [Message.CompletedStartRecording, Message.FailedStartRecording],
  execute: Effect.gen(function* () {
    const mic = yield* Microphone
    yield* mic.start
    return Message.CompletedStartRecording()
  }).pipe(Effect.catch((e) => Effect.succeed(Message.FailedStartRecording({ error: e.message })))),
})

export const StopRecording = Command.define('StopRecording', {
  messages: [Message.CompletedStopRecording, Message.FailedStopRecording],
  execute: Effect.gen(function* () {
    const mic = yield* Microphone
    const recording = yield* mic.stop
    return Message.CompletedStopRecording({ wavBase64: recording?.wavBase64 ?? null, seconds: recording?.seconds ?? 0 })
  }).pipe(Effect.catch((e) => Effect.succeed(Message.FailedStopRecording({ error: e.message })))),
})

export const TranslateText = Command.define('TranslateText', {
  args: { key: Schema.String, model: Schema.String, system: Schema.String, user: Schema.String, said: Schema.String },
  messages: [Message.CompletedTranslate, Message.FailedTranslate],
  execute: ({ key, model, system, user, said }) =>
    Effect.gen(function* () {
      const openRouter = yield* OpenRouter
      const reply = yield* openRouter.chat(
        key,
        model,
        [
          { role: 'system', content: system },
          { role: 'user', content: `${user}\n\nCONTROLLER SAID: ${JSON.stringify(said)}` },
        ],
        400,
      )
      const translation = yield* Effect.try({ try: () => parseTranslation(reply), catch: (e) => new Error(String(e instanceof Error ? e.message : e)) })
      return Message.CompletedTranslate({ translation, said })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.FailedTranslate({ error: e.message, audio: false })))),
})

export const TranslateAudio = Command.define('TranslateAudio', {
  args: { key: Schema.String, model: Schema.String, system: Schema.String, user: Schema.String, wavBase64: Schema.String },
  messages: [Message.CompletedTranslate, Message.FailedTranslate],
  execute: ({ key, model, system, user, wavBase64 }) =>
    Effect.gen(function* () {
      const openRouter = yield* OpenRouter
      const reply = yield* openRouter.chat(
        key,
        model,
        [
          { role: 'system', content: system },
          { role: 'user', content: [{ type: 'text', text: user }, { type: 'input_audio', input_audio: { data: wavBase64, format: 'wav' } }] },
        ],
        500,
      )
      const translation = yield* Effect.try({ try: () => parseTranslation(reply), catch: (e) => new Error(String(e instanceof Error ? e.message : e)) })
      return Message.CompletedTranslate({ translation, said: translation.transcript ?? '(spoken)' })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.FailedTranslate({ error: e.message, audio: true })))),
})

export const UtteranceFields = {
  callsign: Schema.String,
  text: Schema.String,
  engine: Schema.Literals(['browser', 'openrouter']),
  key: Schema.String,
  model: Schema.String,
  providerVoice: Schema.String,
  browserVoice: Schema.String,
  radio: Schema.Boolean,
}

export const Speak = Command.define('Speak', {
  args: UtteranceFields,
  messages: [Message.CompletedSpeak],
  execute: (utterance) =>
    Effect.gen(function* () {
      const speech = yield* Speech
      yield* speech.speak(utterance)
      return Message.CompletedSpeak()
    }),
})

export const StopSpeaking = Command.define('StopSpeaking', {
  messages: [Message.CompletedStopSpeaking],
  execute: Effect.gen(function* () {
    const speech = yield* Speech
    yield* speech.stop
    return Message.CompletedStopSpeaking()
  }),
})

export const StartRecognition = Command.define('StartRecognition', {
  messages: [Message.CompletedStartRecognition, Message.FailedStartRecognition],
  execute: Effect.gen(function* () {
    const recognition = yield* Recognition
    yield* recognition.start
    return Message.CompletedStartRecognition()
  }).pipe(Effect.catch((e) => Effect.succeed(Message.FailedStartRecognition({ error: e.message })))),
})

export const StopRecognition = Command.define('StopRecognition', {
  messages: [Message.CompletedStopRecognition],
  execute: Effect.gen(function* () {
    const recognition = yield* Recognition
    yield* recognition.stop
    return Message.CompletedStopRecognition()
  }),
})

export const ProbeRecognition = Command.define('ProbeRecognition', {
  messages: [Message.CompletedProbeRecognition],
  execute: Effect.gen(function* () {
    const recognition = yield* Recognition
    return Message.CompletedProbeRecognition({ available: recognition.available })
  }),
})

export const LoadBrowserVoices = Command.define('LoadBrowserVoices', {
  messages: [Message.CompletedLoadBrowserVoices],
  execute: Effect.gen(function* () {
    const speech = yield* Speech
    return Message.CompletedLoadBrowserVoices({ voices: yield* speech.browserVoices })
  }),
})

export const LoadModels = Command.define('LoadModels', {
  args: { key: Schema.String },
  messages: [Message.CompletedLoadModels, Message.FailedLoadModels],
  execute: ({ key }) =>
    Effect.gen(function* () {
      const openRouter = yield* OpenRouter
      const speech = yield* Speech
      const models = yield* openRouter.models(key)
      yield* speech.rememberSpeechModels(models.speech)
      return Message.CompletedLoadModels({ models })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.FailedLoadModels({ error: e.message })))),
})

export const TestKey = Command.define('TestKey', {
  args: { key: Schema.String, model: Schema.String },
  messages: [Message.CompletedTestKey],
  execute: ({ key, model }) =>
    Effect.gen(function* () {
      const openRouter = yield* OpenRouter
      const reply = yield* openRouter.chat(key, model, [{ role: 'user', content: 'Reply with exactly the JSON {"ok":true} and nothing else.' }], 30)
      const ok = /"ok"\s*:\s*true/.test(reply)
      return Message.CompletedTestKey({ ok, detail: ok ? `works — ${model} answered` : `answered, but not as JSON: ${reply.slice(0, 60)}` })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.CompletedTestKey({ ok: false, detail: `failed: ${e.message}` })))),
})

export const TEST_VOICE_SAMPLE = 'Runway three zero left, taxi via quebec, charlie, hold short of runway one two right, Delta ten forty-seven'

export const TestVoice = Command.define('TestVoice', {
  args: UtteranceFields,
  messages: [Message.CompletedTestVoice],
  execute: (utterance) =>
    Effect.gen(function* () {
      const speech = yield* Speech
      const seconds = yield* speech.test(utterance)
      return Message.CompletedTestVoice({
        ok: true,
        detail:
          utterance.engine === 'openrouter' && utterance.key !== ''
            ? `played ${utterance.model}${utterance.providerVoice !== '' ? ' · ' + utterance.providerVoice : ''} (${seconds.toFixed(1)}s)`
            : 'playing browser voice',
      })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.CompletedTestVoice({ ok: false, detail: `speech failed: ${e.message}` })))),
})

// SHARED SESSIONS

const randomRoomCode = (): string => {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length]!).join('')
}

export const HostRoom = Command.define('HostRoom', {
  args: { turn: Schema.NullOr(TurnServer) },
  messages: [Message.CompletedHostRoom, Message.FailedJoinRoom],
  execute: ({ turn }) =>
    Effect.gen(function* () {
      const session = yield* Session
      const room = randomRoomCode()
      yield* session.join(room, turn)
      return Message.CompletedHostRoom({ room })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.FailedJoinRoom({ error: e.message })))),
})

export const JoinRoom = Command.define('JoinRoom', {
  args: { room: Schema.String, turn: Schema.NullOr(TurnServer) },
  messages: [Message.CompletedJoinRoom, Message.FailedJoinRoom],
  execute: ({ room, turn }) =>
    Effect.gen(function* () {
      const session = yield* Session
      yield* session.join(room, turn)
      return Message.CompletedJoinRoom({ room })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.FailedJoinRoom({ error: e.message })))),
})

export const LeaveRoom = Command.define('LeaveRoom', {
  messages: [Message.CompletedLeaveRoom],
  execute: Effect.gen(function* () {
    const session = yield* Session
    yield* session.leave
    return Message.CompletedLeaveRoom()
  }),
})

export const SendSession = Command.define('SendSession', {
  args: { event: SessionEvent, target: Schema.NullOr(Schema.String) },
  messages: [Message.CompletedSendSession, Message.FailedSendSession],
  execute: ({ event, target }) =>
    Effect.gen(function* () {
      const session = yield* Session
      yield* session.send(event, target)
      return Message.CompletedSendSession()
    }).pipe(Effect.catch((e) => Effect.succeed(Message.FailedSendSession({ error: e.message })))),
})
