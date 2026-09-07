/**
 * The STARS pane as a Submodel: its own Model (view in nautical miles, map
 * selection, drag), Messages, Commands (video map loading) and OutMessages for
 * the parent (a target was clicked). Pure apart from the Commands and the Mount.
 */
import { Effect, Option, Queue, Schema, Stream } from 'effect'
import { Command, Mount, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { evo } from 'foldkit/struct'

import { storeVideoMap } from '../../app/mapCache'
import type { Stars } from '../../domain/catalog'
import { nmOffset, radarProjectionAt } from '../../domain/geo'
import type { World } from '../../domain/world'
import { VideoMaps } from '../../services/videoMaps'

// MODEL

/** The visible square of the radar plane, in nautical miles east/south of the centre. */
export const RadarView = Schema.Struct({ x: Schema.Number, y: Schema.Number, w: Schema.Number, h: Schema.Number })
export type RadarView = typeof RadarView.Type

export const StarsDrag = Schema.Struct({ startX: Schema.Number, startY: Schema.Number, viewX: Schema.Number, viewY: Schema.Number, moved: Schema.Boolean })
export type StarsDrag = typeof StarsDrag.Type

export const StarsModel = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
  view: RadarView,
  drag: Schema.NullOr(StarsDrag),
  mapsOpen: Schema.Boolean,
  /** video map ids on the display */
  shown: Schema.Array(Schema.String),
  /** video map ids whose geometry is in the map cache */
  loaded: Schema.Array(Schema.String),
})
export type StarsModel = typeof StarsModel.Type

export const DEFAULT_RANGE_NM = 15
export const MIN_VIEW_NM = 6
export const MAX_VIEW_NM = 320
export const MIN_RANGE_NM = 3
export const MAX_RANGE_NM = 160
export const DEFAULT_MAP_COUNT = 4
export const HIT_FRACTION = 0.04

export const rangeView = (range: number): RadarView => ({ x: -range, y: -range, w: 2 * range, h: 2 * range })

export const initialStars: StarsModel = {
  width: 400,
  height: 400,
  view: rangeView(DEFAULT_RANGE_NM),
  drag: null,
  mapsOpen: false,
  shown: [],
  loaded: [],
}

/** The maps on by default: the tower DCB list (first 4) plus every always-visible map. */
export const defaultMaps = (stars: Stars | null): ReadonlyArray<string> => {
  if (stars === null) {
    return []
  }
  const ids = new Set<string>()
  stars.maps.filter((m) => m.av).forEach((m) => ids.add(m.id))
  stars.def.slice(0, DEFAULT_MAP_COUNT).forEach((id) => ids.add(id))
  return [...ids]
}

// MESSAGE

export const StarsMessage = defineMessageUnion({
  Resized: { width: Schema.Number, height: Schema.Number },
  Wheeled: { x: Schema.Number, y: Schema.Number, deltaY: Schema.Number },
  Pressed: { x: Schema.Number, y: Schema.Number },
  Moved: { x: Schema.Number, y: Schema.Number },
  Released: { x: Schema.Number, y: Schema.Number },
  ClickedRangeIn: {},
  ClickedRangeOut: {},
  ClickedCentre: {},
  ClickedMaps: {},
  /** a pointer went down outside the MAPS panel (and its button) while it was open */
  PressedOutsideMaps: {},
  ToggledMap: { id: Schema.String },
  CompletedLoadMap: { id: Schema.String },
  FailedLoadMap: { id: Schema.String, error: Schema.String },
})
export type StarsMessage = typeof StarsMessage.Type

export const StarsOut = defineTaggedUnion({
  SelectedTarget: { callsign: Schema.String },
  Noted: { text: Schema.String },
})
export type StarsOut = typeof StarsOut.Type

// COMMAND

export const LoadStarsMap = Command.define('LoadStarsMap', {
  args: { artcc: Schema.String, id: Schema.String },
  messages: [StarsMessage.CompletedLoadMap, StarsMessage.FailedLoadMap],
  execute: ({ artcc, id }) =>
    Effect.gen(function* () {
      const maps = yield* VideoMaps
      storeVideoMap(yield* maps.load(artcc, id))
      return StarsMessage.CompletedLoadMap({ id })
    }).pipe(Effect.catch((e) => Effect.succeed(StarsMessage.FailedLoadMap({ id, error: e.message })))),
})

type ScopeMessage = ReturnType<typeof StarsMessage.Resized> | ReturnType<typeof StarsMessage.Wheeled>

/** Size and wheel deltas of the radar container (see ScopeSurface for the ground scope). */
export const StarsSurface = Mount.defineStream('StarsSurface', {
  messages: [StarsMessage.Resized, StarsMessage.Wheeled],
  execute: ({ element }) => {
    const sizes = Stream.callback<ScopeMessage>((queue) =>
      Effect.gen(function* () {
        const report = () => {
          const rect = element.getBoundingClientRect()
          Effect.runSync(Queue.offer(queue, StarsMessage.Resized({ width: Math.round(rect.width), height: Math.round(rect.height) })))
        }
        const observer = new ResizeObserver(report)
        observer.observe(element)
        report()
        yield* Effect.addFinalizer(() => Effect.sync(() => observer.disconnect()))
      }),
    )
    /** a wheel over the scrollable MAPS panel scrolls it; only the radar itself zooms */
    const overRadar = (event: WheelEvent): boolean => !(event.target instanceof Element && event.target.closest('.smaps') !== null)
    const wheels = Stream.fromEventListener<WheelEvent>(element, 'wheel', { passive: false }).pipe(
      Stream.filter(overRadar),
      Stream.map((event): ScopeMessage => {
        event.preventDefault()
        const rect = element.getBoundingClientRect()
        return StarsMessage.Wheeled({ x: event.clientX - rect.left, y: event.clientY - rect.top, deltaY: event.deltaY })
      }),
    )
    return Stream.merge(sizes, wheels)
  },
})

// GEOMETRY

export type RadarPoint = Readonly<{ x: number; y: number }>

/** Pixels per nautical mile with the view letterboxed like preserveAspectRatio meet. */
export const pxPerNm = (model: StarsModel): number => Math.min(model.width / model.view.w, model.height / model.view.h) || 20

export const toCanvas = (model: StarsModel, nmX: number, nmY: number): RadarPoint => {
  const s = pxPerNm(model)
  const offsetX = (model.width - model.view.w * s) / 2
  const offsetY = (model.height - model.view.h * s) / 2
  return { x: offsetX + (nmX - model.view.x) * s, y: offsetY + (nmY - model.view.y) * s }
}

export const canvasToNm = (model: StarsModel, x: number, y: number): RadarPoint => {
  const s = pxPerNm(model)
  const offsetX = (model.width - model.view.w * s) / 2
  const offsetY = (model.height - model.view.h * s) / 2
  return { x: model.view.x + (x - offsetX) / s, y: model.view.y + (y - offsetY) / s }
}

export const zoomAt = (model: StarsModel, x: number, y: number, k: number): RadarView => {
  const under = canvasToNm(model, x, y)
  const fx = (under.x - model.view.x) / model.view.w
  const fy = (under.y - model.view.y) / model.view.h
  const nw = Math.max(MIN_VIEW_NM, Math.min(MAX_VIEW_NM, model.view.w * k))
  const nh = nw * (model.view.h / model.view.w)
  return { x: under.x - nw * fx, y: under.y - nh * fy, w: nw, h: nh }
}

/** Radar-plane position of a lon/lat for the world's centre. */
export const radarPoint = (world: World, c: readonly [number, number]): RadarPoint => {
  const centre = world.airport.radarCenter ?? [0, 0]
  const [x, y] = nmOffset(radarProjectionAt(centre[1]), centre, c)
  return { x, y }
}

// INIT / UPDATE

export type StarsInput = Readonly<{ message: StarsMessage; world: World | null }>

export type StarsReturn = Update.ReturnWithOutMessage<StarsModel, StarsMessage, StarsOut, VideoMaps>

/** Fresh pane for an airport: default range and the default maps loading. */
export const starsInit = (model: StarsModel, artcc: string, stars: Stars | null, range: number = DEFAULT_RANGE_NM): Update.Return<StarsModel, StarsMessage, VideoMaps> => {
  const shown = defaultMaps(stars)
  return {
    model: { ...model, view: rangeView(range), drag: null, mapsOpen: false, shown, loaded: model.loaded },
    commands: shown.filter((id) => !model.loaded.includes(id)).map((id) => LoadStarsMap({ artcc, id })),
  }
}

export const starsUpdate = (model: StarsModel, artcc: string, input: StarsInput): StarsReturn =>
  StarsMessage.match<StarsReturn>(input.message, {
    Resized: ({ width, height }) => ({ model: evo(model, { width: () => width, height: () => height }) }),

    Wheeled: ({ x, y, deltaY }) => ({ model: evo(model, { view: () => zoomAt(model, x, y, deltaY > 0 ? 1.13 : 0.885) }) }),

    Pressed: ({ x, y }) => ({ model: evo(model, { drag: () => ({ startX: x, startY: y, viewX: model.view.x, viewY: model.view.y, moved: false }) }) }),

    Moved: ({ x, y }) => {
      const drag = model.drag
      if (drag === null) {
        return { model }
      }
      const s = pxPerNm(model)
      const moved = drag.moved || Math.hypot(x - drag.startX, y - drag.startY) > 3
      return {
        model: evo(model, {
          drag: () => ({ ...drag, moved }),
          view: (view) => ({ ...view, x: drag.viewX - (x - drag.startX) / s, y: drag.viewY - (y - drag.startY) / s }),
        }),
      }
    },

    Released: ({ x, y }) => {
      const drag = model.drag
      const released = evo(model, { drag: () => null })
      if (drag === null || drag.moved || input.world === null) {
        return { model: released }
      }
      const target = canvasToNm(model, x, y)
      let best: string | null = null
      let bestDistance = Infinity
      for (const a of input.world.aircraft) {
        if (a.radar === null) {
          continue
        }
        const p = radarPoint(input.world, a.radar.position)
        const d = Math.hypot(p.x - target.x, p.y - target.y)
        if (d < bestDistance) {
          bestDistance = d
          best = a.callsign
        }
      }
      return best !== null && bestDistance < model.view.w * HIT_FRACTION
        ? { model: released, outMessage: StarsOut.SelectedTarget({ callsign: best }) }
        : { model: released }
    },

    ClickedRangeIn: () => ({ model: evo(model, { view: (view) => rangeView(Math.max(MIN_RANGE_NM, Math.round(view.w / 2 / 1.5))) }) }),
    ClickedRangeOut: () => ({ model: evo(model, { view: (view) => rangeView(Math.min(MAX_RANGE_NM, Math.round((view.w / 2) * 1.5))) }) }),
    ClickedCentre: () => ({ model: evo(model, { view: () => rangeView(DEFAULT_RANGE_NM) }) }),
    ClickedMaps: () => ({ model: evo(model, { mapsOpen: (open) => !open }) }),
    PressedOutsideMaps: () => ({ model: evo(model, { mapsOpen: () => false }) }),

    ToggledMap: ({ id }) => {
      if (model.shown.includes(id)) {
        return { model: evo(model, { shown: (shown) => shown.filter((x) => x !== id) }) }
      }
      const next = evo(model, { shown: (shown) => [...shown, id] })
      return model.loaded.includes(id) ? { model: next } : { model: next, commands: [LoadStarsMap({ artcc, id })] }
    },

    CompletedLoadMap: ({ id }) => ({ model: evo(model, { loaded: (loaded) => (loaded.includes(id) ? loaded : [...loaded, id]) }) }),

    FailedLoadMap: ({ id, error }) => ({
      model: evo(model, { shown: (shown) => shown.filter((x) => x !== id) }),
      outMessage: StarsOut.Noted({ text: `map ${id}: ${error}` }),
    }),
  })

export const someStars = (model: StarsModel): Option.Option<StarsModel> => Option.some(model)
