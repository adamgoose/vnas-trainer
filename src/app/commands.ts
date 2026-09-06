/**
 * Everything that touches the outside world: catalog and vNAS data, video maps,
 * settings storage, the URL hash, focus, and the scope surface Mount that reports
 * its size and wheel events.
 */
import { Effect, Queue, Schema, Stream } from 'effect'
import { Command, Dom, Mount } from 'foldkit'

import { storeVideoMap } from './mapCache'
import { Message } from './message'
import { Settings, SettingsStore } from '../services/settings'
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

export const parseDeepLink = (hash: string): Readonly<{ airport: string | null; scenario: string | null }> => {
  const [apt = '', scen = ''] = hash.replace(/^#/, '').split('/')
  return { airport: apt.toUpperCase() || null, scenario: scen || null }
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
