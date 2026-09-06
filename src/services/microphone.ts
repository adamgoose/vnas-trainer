/**
 * Push-to-talk capture: MediaRecorder on the microphone, decoded and resampled
 * to 16 kHz mono 16-bit WAV, base64 for the audio models. Under 0.4 s is ignored.
 */
import { Context, Data, Effect, Layer } from 'effect'

import { encodeWav, toBase64 } from '../domain/wav'

export class MicrophoneError extends Data.TaggedError('MicrophoneError')<{ message: string }> {}

export type Recording = Readonly<{ wavBase64: string; seconds: number }>

export const MIN_TRANSMISSION_S = 0.4
export const WAV_RATE = 16000

export type MicrophoneShape = Readonly<{
  start: Effect.Effect<void, MicrophoneError>
  /** null when the transmission was too short */
  stop: Effect.Effect<Recording | null, MicrophoneError>
}>

export class Microphone extends Context.Service<Microphone, MicrophoneShape>()('Microphone') {}

const fail = (e: unknown): MicrophoneError => new MicrophoneError({ message: e instanceof Error ? e.message : String(e) })

export const wavFromBlob = async (blob: Blob): Promise<string> => {
  const decoder = new AudioContext()
  const source = await decoder.decodeAudioData(await blob.arrayBuffer())
  await decoder.close().catch(() => undefined)
  const frames = Math.max(1, Math.ceil(source.duration * WAV_RATE))
  const offline = new OfflineAudioContext(1, frames, WAV_RATE)
  const node = offline.createBufferSource()
  node.buffer = source
  node.connect(offline.destination)
  node.start()
  const rendered = await offline.startRendering()
  return toBase64(encodeWav(rendered.getChannelData(0), WAV_RATE))
}

export const MicrophoneBrowser = Layer.sync(Microphone)(() => {
  let stream: MediaStream | null = null
  let recorder: MediaRecorder | null = null
  let chunks: Array<Blob> = []
  let startedAt = 0
  return {
    start: Effect.tryPromise({
      try: async () => {
        stream ??= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
        chunks = []
        recorder = new MediaRecorder(stream)
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            chunks.push(e.data)
          }
        }
        recorder.start()
        startedAt = performance.now()
      },
      catch: fail,
    }),
    stop: Effect.tryPromise({
      try: async () => {
        const active = recorder
        recorder = null
        if (active === null || active.state === 'inactive') {
          return null
        }
        await new Promise<void>((resolve) => {
          active.onstop = () => resolve()
          active.stop()
        })
        const seconds = (performance.now() - startedAt) / 1000
        const blob = new Blob(chunks, { type: active.mimeType })
        if (seconds < MIN_TRANSMISSION_S || blob.size === 0) {
          return null
        }
        return { wavBase64: await wavFromBlob(blob), seconds }
      },
      catch: fail,
    }),
  } satisfies MicrophoneShape
})

export const MicrophoneFake = (recording: Recording | null) =>
  Layer.succeed(Microphone)({ start: Effect.void, stop: Effect.succeed(recording) })
