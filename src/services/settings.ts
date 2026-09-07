/**
 * User settings in localStorage under `vgt.settings`. The key names are the
 * legacy app's so users keep their settings across the rewrite.
 */
import { Context, Effect, Layer, Schema } from 'effect'

export const MIN_TAG_SIZE = 8
export const MAX_TAG_SIZE = 18

export const Settings = Schema.Struct({
  key: Schema.String,
  model: Schema.String,
  audioModel: Schema.String,
  proxy: Schema.String,
  tts: Schema.Boolean,
  ttsEngine: Schema.Literals(['browser', 'openrouter']),
  ttsModel: Schema.String,
  ttsVoice: Schema.String,
  voice: Schema.String,
  radio: Schema.Boolean,
  mode: Schema.Literals(['ground', 'tower', 'tracon']),
  view: Schema.Literals(['ground', 'both', 'stars']),
  /** shared sessions: an optional TURN relay for NATs that block direct connections */
  turnUrl: Schema.String,
  turnUsername: Schema.String,
  turnCredential: Schema.String,
  /** ASDE-X display: data blocks on parked aircraft, data block font size in CSS px, the command ring on a click */
  asdexParkedTags: Schema.Boolean,
  asdexTagSize: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: MIN_TAG_SIZE, maximum: MAX_TAG_SIZE }))),
  radialMenu: Schema.Boolean,
})
export type Settings = typeof Settings.Type

export const SETTINGS_KEY = 'vgt.settings'

export const defaultSettings: Settings = {
  key: '',
  model: 'anthropic/claude-haiku-4.5',
  audioModel: 'google/gemini-3.5-flash-lite',
  proxy: '',
  tts: true,
  ttsEngine: 'browser',
  ttsModel: 'hexgrad/kokoro-82m',
  ttsVoice: '',
  voice: '',
  radio: true,
  mode: 'ground',
  view: 'both',
  turnUrl: '',
  turnUsername: '',
  turnCredential: '',
  asdexParkedTags: false,
  asdexTagSize: 11,
  radialMenu: true,
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Merge stored values over the defaults, keeping only fields that decode. */
export const mergeSettings = (stored: unknown): Settings => {
  if (!isRecord(stored)) {
    return defaultSettings
  }
  const merged: Record<string, unknown> = { ...defaultSettings }
  for (const key of Object.keys(defaultSettings) as Array<keyof Settings>) {
    const candidate = { ...defaultSettings, [key]: stored[key] }
    if (stored[key] !== undefined && Schema.decodeUnknownOption(Settings)(candidate)._tag === 'Some') {
      merged[key] = stored[key]
    }
  }
  return merged as Settings
}

export type SettingsStoreShape = Readonly<{
  load: Effect.Effect<Settings>
  save: (settings: Settings) => Effect.Effect<void>
}>

export class SettingsStore extends Context.Service<SettingsStore, SettingsStoreShape>()('SettingsStore') {}

type StringStorage = Readonly<{ getItem: (k: string) => string | null; setItem: (k: string, v: string) => void }>

/** Over any localStorage-shaped store; errors (private mode, quota) fall back to defaults silently. */
export const SettingsStoreFromStorage = (storage: () => StringStorage | null) =>
  Layer.succeed(SettingsStore)({
    load: Effect.sync(() => {
      try {
        const raw = storage()?.getItem(SETTINGS_KEY)
        return mergeSettings(raw ? JSON.parse(raw) : {})
      } catch {
        return defaultSettings
      }
    }),
    save: (settings) =>
      Effect.sync(() => {
        try {
          storage()?.setItem(SETTINGS_KEY, JSON.stringify(settings))
        } catch {
          /* ignore */
        }
      }),
  })

export const SettingsStoreBrowser = SettingsStoreFromStorage(() => (typeof localStorage === 'undefined' ? null : localStorage))

export const SettingsStoreMemory = (initial: Record<string, string> = {}) => {
  const store = new Map(Object.entries(initial))
  return SettingsStoreFromStorage(() => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }))
}
