/**
 * OpenRouter (docs/REWRITE.md section 2): chat completions (text or with an audio
 * part), the model catalogue, and text-to-speech. The key is passed per call, so
 * the layer holds no secret. A test layer takes canned handlers.
 */
import { Context, Data, Effect, Layer } from 'effect'

export const OPENROUTER = 'https://openrouter.ai/api/v1'

export class OpenRouterError extends Data.TaggedError('OpenRouterError')<{ message: string }> {}

export type ChatPart = Readonly<{ type: 'text'; text: string }> | Readonly<{ type: 'input_audio'; input_audio: Readonly<{ data: string; format: 'wav' }> }>
export type ChatMessage = Readonly<{ role: 'system' | 'user'; content: string | ReadonlyArray<ChatPart> }>

export type ModelCatalogue = Readonly<{
  /** every model id */
  ids: ReadonlyArray<string>
  /** models whose input modalities include audio */
  audioIds: ReadonlyArray<string>
  /** speech models: id to voices (null when the provider lists none) */
  speech: Readonly<Record<string, ReadonlyArray<string> | null>>
}>

export type OpenRouterShape = Readonly<{
  chat: (key: string, model: string, messages: ReadonlyArray<ChatMessage>, maxTokens: number) => Effect.Effect<string, OpenRouterError>
  models: (key: string) => Effect.Effect<ModelCatalogue, OpenRouterError>
  /** raw mp3 bytes */
  speech: (key: string, model: string, input: string, voice: string | undefined) => Effect.Effect<ArrayBuffer, OpenRouterError>
}>

export class OpenRouter extends Context.Service<OpenRouter, OpenRouterShape>()('OpenRouter') {}

const headers = (key: string): Record<string, string> => ({
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': globalThis.location?.origin ?? 'https://vnas-trainer.local',
  'X-Title': 'vNAS Trainer',
})

const failed = (e: unknown): OpenRouterError => new OpenRouterError({ message: e instanceof Error ? e.message : String(e) })

const errorText = async (r: Response): Promise<string> => {
  const t = await r.text().catch(() => '')
  try {
    const j = JSON.parse(t) as { error?: { message?: string } }
    return j.error?.message ?? t.slice(0, 160)
  } catch {
    return t.slice(0, 160)
  }
}

type ModelsReply = Readonly<{ data?: ReadonlyArray<Readonly<{ id: string; architecture?: Readonly<{ input_modalities?: ReadonlyArray<string> }>; supported_voices?: ReadonlyArray<string> | null }>> }>

export const OpenRouterLive = Layer.succeed(OpenRouter)({
  chat: (key, model, messages, maxTokens) =>
    Effect.tryPromise({
      try: async () => {
        const r = await fetch(`${OPENROUTER}/chat/completions`, {
          method: 'POST',
          headers: headers(key),
          body: JSON.stringify({ model, messages, temperature: 0, max_tokens: maxTokens }),
        })
        if (!r.ok) {
          throw new Error(`HTTP ${r.status} ${await errorText(r)}`)
        }
        const j = (await r.json()) as { error?: { message?: string }; choices?: ReadonlyArray<{ message?: { content?: string } }> }
        if (j.error) {
          throw new Error(j.error.message ?? 'provider error')
        }
        return j.choices?.[0]?.message?.content ?? ''
      },
      catch: failed,
    }),

  models: (key) =>
    Effect.tryPromise({
      try: async () => {
        const [all, speech] = await Promise.all([
          fetch(`${OPENROUTER}/models`, { headers: headers(key) }).then((r) => r.json() as Promise<ModelsReply>),
          fetch(`${OPENROUTER}/models?output_modalities=speech`, { headers: headers(key) }).then((r) => r.json() as Promise<ModelsReply>),
        ])
        const data = all.data ?? []
        return {
          ids: data.map((m) => m.id).sort(),
          audioIds: data.filter((m) => (m.architecture?.input_modalities ?? []).includes('audio')).map((m) => m.id).sort(),
          speech: Object.fromEntries((speech.data ?? []).map((m) => [m.id, m.supported_voices ?? null])),
        } satisfies ModelCatalogue
      },
      catch: failed,
    }),

  speech: (key, model, input, voice) =>
    Effect.tryPromise({
      try: async () => {
        const body: Record<string, unknown> = { model, input, response_format: 'mp3' }
        if (voice !== undefined) {
          body['voice'] = voice
        }
        const r = await fetch(`${OPENROUTER}/audio/speech`, { method: 'POST', headers: headers(key), body: JSON.stringify(body) })
        if (!r.ok) {
          throw new Error(`HTTP ${r.status} ${await errorText(r)}`)
        }
        return r.arrayBuffer()
      },
      catch: failed,
    }),
})

/** Canned replies for tests: `chat` gets the messages and returns the model text. */
export const OpenRouterFromHandlers = (handlers: Partial<OpenRouterShape>) =>
  Layer.succeed(OpenRouter)({
    chat: handlers.chat ?? (() => Effect.fail(new OpenRouterError({ message: 'no chat handler' }))),
    models: handlers.models ?? (() => Effect.fail(new OpenRouterError({ message: 'no models handler' }))),
    speech: handlers.speech ?? (() => Effect.fail(new OpenRouterError({ message: 'no speech handler' }))),
  })
