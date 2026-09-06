import { Clock, Option, Schema, Stream } from 'effect'
import { Subscription } from 'foldkit'

import { parseDeepLink } from './commands'
import { Message } from './message'
import { type Model } from './model'
import { SIM_STEP_S } from '../domain/physics'
import type { SettingsStore } from '../services/settings'
import type { VideoMaps } from '../services/videoMaps'
import type { VnasData } from '../services/vnasData'

export const TICK_MS = SIM_STEP_S * 1000

export type Services = VnasData | VideoMaps | SettingsStore

const isTyping = (): boolean => {
  const el = globalThis.document?.activeElement
  return el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
}

export const subscriptions = Subscription.make<Model, Message, Services>()((entry) => ({
  tick: entry(
    { isActive: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isActive: model.running && model.airport._tag === 'Ready' }),
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
            return Option.none()
          },
        }),
    },
  ),
}))
