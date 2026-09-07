/**
 * Peer connections for shared sessions over WebRTC data channels, signaled
 * through public Nostr relays by Trystero (no server of ours). One room per
 * session; every peer connects to every other. A fake layer records sends for
 * tests.
 */
import { Context, Data, Effect, Layer, PubSub, Schema, Stream } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'
import { type JsonValue, type MessageAction, type Room, joinRoom, selfId } from 'trystero'

import { type SessionEvent, decodeSessionEvent, encodeSessionEvent } from '../domain/session'

export const APP_ID = 'vnas-trainer'

export class SessionError extends Data.TaggedError('SessionError')<{ message: string }> {}

export const TurnServer = Schema.Struct({ url: Schema.String, username: Schema.String, credential: Schema.String })
export type TurnServer = typeof TurnServer.Type

export const SessionIncoming = defineTaggedUnion({
  PeerJoined: { peerId: Schema.String },
  PeerLeft: { peerId: Schema.String },
  Received: { peerId: Schema.String, event: Schema.Unknown },
  JoinFailed: { error: Schema.String },
})
export type SessionIncoming = typeof SessionIncoming.Type

export type SessionShape = Readonly<{
  selfId: string
  join: (room: string, turn: TurnServer | null) => Effect.Effect<void, SessionError>
  leave: Effect.Effect<void>
  /** `target` null broadcasts to every peer */
  send: (event: SessionEvent, target: string | null) => Effect.Effect<void, SessionError>
  events: Stream.Stream<SessionIncoming>
}>

export class Session extends Context.Service<Session, SessionShape>()('Session') {}

const ACTION = 'vnas'

export const SessionTrystero = Layer.effect(Session)(
  Effect.gen(function* () {
    const incoming = yield* PubSub.unbounded<SessionIncoming>()
    const publish = (event: SessionIncoming) => Effect.runSync(PubSub.publish(incoming, event))
    let room: Room | null = null
    let action: MessageAction<JsonValue> | null = null
    return {
      selfId,
      join: (code, turn) =>
        Effect.try({
          try: () => {
            if (room !== null) {
              void room.leave()
            }
            room = joinRoom(
              {
                appId: APP_ID,
                // Candidates travel inside the SDP: fewer relay round trips, and a throttled tab still completes the handshake.
                trickleIce: false,
                relayConfig: { redundancy: 4 },
                ...(turn !== null && turn.url !== '' ? { turnConfig: [{ urls: turn.url, username: turn.username, credential: turn.credential }] } : {}),
              },
              code,
              { onJoinError: ({ error }) => publish(SessionIncoming.JoinFailed({ error: String(error) })) },
            )
            room.onPeerJoin = (peerId) => publish(SessionIncoming.PeerJoined({ peerId }))
            room.onPeerLeave = (peerId) => publish(SessionIncoming.PeerLeft({ peerId }))
            const made = room.makeAction<JsonValue>(ACTION)
            action = made
            made.onMessage = (data, { peerId }) => {
              try {
                publish(SessionIncoming.Received({ peerId, event: decodeSessionEvent(data) }))
              } catch {
                /* not one of ours */
              }
            }
          },
          catch: (e) => new SessionError({ message: e instanceof Error ? e.message : String(e) }),
        }),
      leave: Effect.promise(async () => {
        const current = room
        room = null
        action = null
        await current?.leave()
      }),
      send: (event, target) =>
        Effect.tryPromise({
          try: async () => {
            if (action === null) {
              throw new Error('not in a session')
            }
            await action.send(encodeSessionEvent(event) as JsonValue, target === null ? {} : { target })
          },
          catch: (e) => new SessionError({ message: e instanceof Error ? e.message : String(e) }),
        }),
      events: Stream.fromPubSub(incoming),
    } satisfies SessionShape
  }),
)

/** Records joins and sends for tests. */
export const SessionRecording = (log: Array<Readonly<{ kind: 'join' | 'leave' | 'send'; room?: string; target?: string | null; event?: SessionEvent }>>, id = 'me') =>
  Layer.succeed(Session)({
    selfId: id,
    join: (room) => Effect.sync(() => void log.push({ kind: 'join', room })),
    leave: Effect.sync(() => void log.push({ kind: 'leave' })),
    send: (event, target) => Effect.sync(() => void log.push({ kind: 'send', target, event })),
    events: Stream.empty,
  })
