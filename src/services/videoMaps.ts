/**
 * Video map geometry from `/Files/VideoMaps/{ARTCC}/{id}.geojson`, which vNAS
 * serves with CORS headers, so no proxy is involved.
 */
import { Context, Effect, Layer } from 'effect'

import { type VideoMap, parseVideoMap } from '../domain/videomap'
import { FILES, type GeoJson, parseLenientJSON } from '../domain/vnas'
import { HttpText } from './http'
import { DataError } from './vnasData'

export type VideoMapsShape = Readonly<{
  load: (artcc: string, id: string) => Effect.Effect<VideoMap, DataError>
}>

export class VideoMaps extends Context.Service<VideoMaps, VideoMapsShape>()('VideoMaps') {}

export const videoMapUrl = (artcc: string, id: string): string => `${FILES}/VideoMaps/${artcc}/${id}.geojson`

export const VideoMapsLive = Layer.effect(VideoMaps)(
  Effect.gen(function* () {
    const http = yield* HttpText
    return {
      load: (artcc, id) =>
        http.get(videoMapUrl(artcc, id)).pipe(
          Effect.flatMap((text) =>
            Effect.try({ try: () => parseVideoMap(id, parseLenientJSON(text) as GeoJson), catch: (e) => new Error(String(e)) }),
          ),
          Effect.mapError((e) => new DataError({ message: e.message })),
        ),
    } satisfies VideoMapsShape
  }),
)
