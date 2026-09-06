/**
 * The one place the app talks HTTP. `HttpText.get` returns a body as text so the
 * callers can run the lenient JSON repair; tests provide an in-memory layer.
 */
import { Context, Data, Effect, Layer } from 'effect'

export class HttpError extends Data.TaggedError('HttpError')<{ url: string; message: string }> {}

export type HttpTextShape = Readonly<{
  get: (url: string) => Effect.Effect<string, HttpError>
}>

export class HttpText extends Context.Service<HttpText, HttpTextShape>()('HttpText') {}

export const HttpTextLive = Layer.succeed(HttpText)({
  get: (url) =>
    Effect.tryPromise({
      try: async () => {
        const r = await fetch(url, { headers: { accept: 'application/json' } })
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}`)
        }
        return r.text()
      },
      catch: (e) => new HttpError({ url, message: e instanceof Error ? e.message : String(e) }),
    }),
})

/** Serves canned bodies by exact URL; anything else is a 404. */
export const HttpTextFromRecord = (bodies: Readonly<Record<string, string>>) =>
  Layer.succeed(HttpText)({
    get: (url) => {
      const body = bodies[url]
      return body === undefined ? Effect.fail(new HttpError({ url, message: 'HTTP 404' })) : Effect.succeed(body)
    },
  })
