/**
 * Everything that touches the outside world: catalog and vNAS data, video maps,
 * settings storage, the URL hash, focus, and the scope surface Mount that reports
 * its size and wheel events.
 */
import { Effect, Queue, Schema, Stream } from 'effect'
import { Command, Dom, Mount } from 'foldkit'

import { Dir, type Edge, Grip, PANELS, type Panel } from './layout'
import { storeVideoMap, videoMapById } from './mapCache'
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

export const LoadArtcc = Command.define('LoadArtcc', {
  args: { source: DataSource, id: Schema.String },
  messages: [Message.CompletedLoadArtcc, Message.FailedLoadArtcc],
  execute: ({ source, id }) =>
    Effect.gen(function* () {
      const data = yield* VnasData
      return Message.CompletedLoadArtcc({ artcc: yield* data.artcc(source, id) })
    }).pipe(Effect.catch((e) => Effect.succeed(Message.FailedLoadArtcc({ id, error: e.message })))),
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
      if (videoMapById(id) === undefined) {
        const maps = yield* VideoMaps
        storeVideoMap(yield* maps.load(artcc, id))
      }
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
 * whenever it changes, wheel events with their deltas, which Foldkit's
 * `OnWheel` attribute does not carry, and right-clicks over the canvas or the
 * command ring. Wheel events are non-passive so the page never scrolls while
 * zooming; the browser's context menu is suppressed everywhere on the scope.
 */
type ScopeMessage = ReturnType<typeof Message.ResizedScope> | ReturnType<typeof Message.WheeledScope> | ReturnType<typeof Message.ContextScope>

export const ScopeSurface = Mount.defineStream('ScopeSurface', {
  messages: [Message.ResizedScope, Message.WheeledScope, Message.ContextScope],
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
    const contexts = Stream.fromEventListener<MouseEvent>(element, 'contextmenu').pipe(
      Stream.map((event): ScopeMessage | null => {
        event.preventDefault()
        if (!(event.target instanceof Element) || event.target.closest('.scope-canvas, .radial') === null) {
          return null
        }
        const rect = element.getBoundingClientRect()
        return Message.ContextScope({ x: event.clientX - rect.left, y: event.clientY - rect.top })
      }),
      Stream.filter((message): message is ScopeMessage => message !== null),
    )
    return Stream.merge(Stream.merge(sizes, wheels), contexts)
  },
})

/** The workspace under the bar: its CSS size, so floating windows can be placed and kept on screen. */
export const WorkspaceSurface = Mount.defineStream('WorkspaceSurface', {
  messages: [Message.ResizedWorkspace],
  execute: ({ element }) =>
    Stream.callback<ReturnType<typeof Message.ResizedWorkspace>>((queue) =>
      Effect.gen(function* () {
        const report = () => {
          const rect = element.getBoundingClientRect()
          Effect.runSync(Queue.offer(queue, Message.ResizedWorkspace({ width: Math.round(rect.width), height: Math.round(rect.height) })))
        }
        const observer = new ResizeObserver(report)
        observer.observe(element)
        report()
        yield* Effect.addFinalizer(() => Effect.sync(() => observer.disconnect()))
      }),
    ),
})

/** Which side of a tile the pointer is on: the nearest edge within its outer quarter, else the centre. */
export const edgeAt = (rx: number, ry: number): Edge => {
  const candidates: ReadonlyArray<readonly [number, Edge]> = [
    [rx, 'left'],
    [1 - rx, 'right'],
    [ry, 'top'],
    [1 - ry, 'bottom'],
  ]
  const nearest = candidates.reduce((best, c) => (c[0] < best[0] ? c : best))
  return nearest[0] > 0.25 ? 'center' : nearest[1]
}

const isPanel = (value: string | undefined): value is Panel => value !== undefined && (PANELS as ReadonlyArray<string>).includes(value)

/**
 * A pointer drag on a layout handle, reported in workspace CSS px with pointer
 * capture so it survives leaving the element. A gutter also reports where the
 * pointer is along its parent split; a window's title bar also reports the tile
 * under the pointer (found in the DOM, since the Model has no geometry) and the
 * side of it the pointer is nearest. A floating window only looks for a tile
 * while Shift is held, so a plain drag moves it; a tiled window always does.
 */
type HandleMessage = ReturnType<typeof Message.DraggedHandle>

export const DragHandle = Mount.defineStream('DragHandle', {
  args: { kind: Schema.Literals(['gutter', 'window', 'resize']), key: Schema.String, index: Schema.Number, dir: Schema.NullOr(Dir), grip: Schema.NullOr(Grip) },
  messages: [Message.DraggedHandle],
  execute: ({ element, kind, key, index, dir, grip }) =>
    Stream.callback<HandleMessage>((queue) =>
      Effect.gen(function* () {
        const handle = element as HTMLElement
        const own = handle.closest('.win')
        const workspace = () => (handle.closest('.workspace') ?? handle).getBoundingClientRect()
        const target = (event: PointerEvent): Readonly<{ over: Panel | null; edge: Edge | null }> => {
          if (kind !== 'window' || (own !== null && own.classList.contains('floating') && !event.shiftKey)) {
            return { over: null, edge: null }
          }
          const tile = document.elementsFromPoint(event.clientX, event.clientY).find((el) => el.matches('.win.tiled') && el !== own)
          if (!(tile instanceof HTMLElement) || !isPanel(tile.dataset['panel'])) {
            return { over: null, edge: null }
          }
          const rect = tile.getBoundingClientRect()
          return { over: tile.dataset['panel'], edge: edgeAt((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height) }
        }
        const at = (phase: 'down' | 'move' | 'up', event: PointerEvent): HandleMessage => {
          const ws = workspace()
          const parent = (handle.parentElement ?? handle).getBoundingClientRect()
          const fraction =
            kind !== 'gutter' ? 0 : dir === 'col' ? (parent.height === 0 ? 0.5 : (event.clientY - parent.top) / parent.height) : parent.width === 0 ? 0.5 : (event.clientX - parent.left) / parent.width
          return Message.DraggedHandle({ kind, key, index, dir, grip, phase, x: event.clientX - ws.left, y: event.clientY - ws.top, fraction, ...target(event) })
        }
        const offer = (message: HandleMessage) => Effect.runSync(Queue.offer(queue, message))
        let pointer: number | null = null
        const move = (event: PointerEvent) => {
          if (event.pointerId === pointer) {
            offer(at('move', event))
          }
        }
        const up = (event: PointerEvent) => {
          if (event.pointerId !== pointer) {
            return
          }
          pointer = null
          document.removeEventListener('pointermove', move)
          document.removeEventListener('pointerup', up)
          document.removeEventListener('pointercancel', up)
          if (handle.hasPointerCapture(event.pointerId)) {
            handle.releasePointerCapture(event.pointerId)
          }
          offer(at('up', event))
        }
        /** Moves and the release are taken from the document: pointer capture is only a courtesy, some embedders ignore it. */
        const down = (event: PointerEvent) => {
          if (event.button !== 0 || pointer !== null || (event.target instanceof Element && event.target.closest('button') !== null)) {
            return
          }
          event.preventDefault()
          pointer = event.pointerId
          try {
            handle.setPointerCapture(event.pointerId)
          } catch {
            /* a synthetic pointer cannot be captured */
          }
          document.addEventListener('pointermove', move)
          document.addEventListener('pointerup', up)
          document.addEventListener('pointercancel', up)
          offer(at('down', event))
        }
        handle.addEventListener('pointerdown', down)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            handle.removeEventListener('pointerdown', down)
            document.removeEventListener('pointermove', move)
            document.removeEventListener('pointerup', up)
            document.removeEventListener('pointercancel', up)
          }),
        )
      }),
    ),
})

/**
 * The lanes area of the rewind panel: a press, and the drag that follows it,
 * report where the pointer is as fractions of the area (x along the track, y
 * down the lanes), so the update can pick the branch and the tick.
 */
type TimelineMessage = ReturnType<typeof Message.ScrubbedTimeline>

export const TimelineSurface = Mount.defineStream('TimelineSurface', {
  messages: [Message.ScrubbedTimeline],
  execute: ({ element }) =>
    Stream.callback<TimelineMessage>((queue) =>
      Effect.gen(function* () {
        const area = element as HTMLElement
        let dragging = false
        const at = (event: PointerEvent): TimelineMessage => {
          const rect = area.getBoundingClientRect()
          return Message.ScrubbedTimeline({
            fx: rect.width === 0 ? 0 : (event.clientX - rect.left) / rect.width,
            fy: rect.height === 0 ? 0 : (event.clientY - rect.top) / rect.height,
          })
        }
        const offer = (event: PointerEvent) => Effect.runSync(Queue.offer(queue, at(event)))
        const down = (event: PointerEvent) => {
          if (event.button !== 0) {
            return
          }
          event.preventDefault()
          dragging = true
          area.setPointerCapture(event.pointerId)
          offer(event)
        }
        const move = (event: PointerEvent) => {
          if (dragging) {
            offer(event)
          }
        }
        const up = (event: PointerEvent) => {
          if (!dragging) {
            return
          }
          dragging = false
          if (area.hasPointerCapture(event.pointerId)) {
            area.releasePointerCapture(event.pointerId)
          }
        }
        area.addEventListener('pointerdown', down)
        area.addEventListener('pointermove', move)
        area.addEventListener('pointerup', up)
        area.addEventListener('pointercancel', up)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            area.removeEventListener('pointerdown', down)
            area.removeEventListener('pointermove', move)
            area.removeEventListener('pointerup', up)
            area.removeEventListener('pointercancel', up)
          }),
        )
      }),
    ),
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
