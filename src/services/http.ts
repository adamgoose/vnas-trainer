/**
 * The one place the app talks HTTP. `HttpText.get` returns a body as text so the
 * callers can run the lenient JSON repair; tests provide an in-memory layer.
 */
import { Context, Data, Effect, Layer } from 'effect'

export class HttpError extends Data.TaggedError('HttpError')<{ url: string; message: string }> {}

export type HttpTextShape = Readonly<{
  get: (url: string) => Effect.Effect<string, HttpError>
  /** binary bodies (NavData.dat) */
  bytes: (url: string) => Effect.Effect<Uint8Array, HttpError>
}>

export class HttpText extends Context.Service<HttpText, HttpTextShape>()('HttpText') {}

const fetching = <A>(url: string, accept: string, read: (r: Response) => Promise<A>) =>
  Effect.tryPromise({
    try: async () => {
      const r = await fetch(url, { headers: { accept } })
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`)
      }
      return read(r)
    },
    catch: (e) => new HttpError({ url, message: e instanceof Error ? e.message : String(e) }),
  })

export const HttpTextLive = Layer.succeed(HttpText)({
  get: (url) => fetching(url, 'application/json', (r) => r.text()),
  bytes: (url) => fetching(url, 'application/octet-stream', async (r) => new Uint8Array(await r.arrayBuffer())),
})

/** Serves canned bodies by exact URL; anything else is a 404. */
export const HttpTextFromRecord = (bodies: Readonly<Record<string, string>>, binaries: Readonly<Record<string, Uint8Array>> = {}) =>
  Layer.succeed(HttpText)({
    get: (url) => {
      const body = bodies[url]
      return body === undefined ? Effect.fail(new HttpError({ url, message: 'HTTP 404' })) : Effect.succeed(body)
    },
    bytes: (url) => {
      const body = binaries[url]
      return body === undefined ? Effect.fail(new HttpError({ url, message: 'HTTP 404' })) : Effect.succeed(body)
    },
  })
