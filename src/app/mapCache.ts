/**
 * Video-map geometry is large and static, so it stays out of the Model (which
 * DevTools snapshots): the LoadPavement command stores it here and the scope view
 * reads it by id. The Model only records which map id is ready.
 */
import type { VideoMap } from '../domain/videomap'

const maps = new Map<string, VideoMap>()

export const storeVideoMap = (map: VideoMap): void => {
  maps.set(map.id, map)
}

export const videoMapById = (id: string): VideoMap | undefined => maps.get(id)
