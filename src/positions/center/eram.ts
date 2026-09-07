/**
 * The ERAM display as a Submodel (Phase 9, the En Route position): the view in
 * nautical miles, the GeoMap shown with its filters, the maps loaded for it,
 * per-track data block settings (FDB or LDB, position, leader, halo, VCI),
 * route displays, the velocity vector length, and the MCA feedback and
 * Response Area text. Pure apart from the map-loading Command and the Mount.
 * Geometry (canvas <-> nm) is shared with the STARS pane.
 */
import { Effect, Option, Schema } from 'effect'
import { Command, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { evo } from 'foldkit/struct'

import { storeVideoMap } from '../../app/mapCache'
import type { ArtccFile, GeoMap } from '../../domain/catalog'
import { DisplayCommand } from '../../domain/commands'
import type { World } from '../../domain/world'
import { VideoMaps } from '../../services/videoMaps'
import { HIT_FRACTION, MIN_RANGE_NM, RadarView, StarsDrag, canvasToNm, pxPerNm, radarPoint, rangeView, zoomAt } from '../local/stars'

// MODEL

/** How one track's data block is shown; `null` fields fall back to the track's state and the pane defaults. */
export const BlockState = Schema.Struct({
  /** full data block on or off; null follows the track (owned tracks get an FDB) */
  fdb: Schema.NullOr(Schema.Boolean),
  /** 1..9 as ERAM numbers them (1 SW, 2 S, 3 SE, 4 W, 5 default, 6 E, 7 NW, 8 N, 9 NE) */
  position: Schema.Number,
  /** leader length 0..3; null is the pane default */
  leader: Schema.NullOr(Schema.Number),
  halo: Schema.Boolean,
  /** VCI shown; null follows whether the aircraft has checked in */
  vci: Schema.NullOr(Schema.Boolean),
  /** line 4 shows the heading/speed/free text instead of the destination */
  hsf: Schema.Boolean,
})
export type BlockState = typeof BlockState.Type

export const defaultBlock: BlockState = { fdb: null, position: 5, leader: null, halo: false, vci: null, hsf: true }

export const Feedback = Schema.Struct({ ok: Schema.Boolean, text: Schema.String })
export type Feedback = typeof Feedback.Type

export const EramModel = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
  view: RadarView,
  drag: Schema.NullOr(StarsDrag),
  /** the GeoMap shown (only one at a time) and its filter buttons that are on, 1-based */
  geoMap: Schema.NullOr(Schema.String),
  filters: Schema.Array(Schema.Number),
  /** Top-Down mode: TDM-only maps (airport diagrams) are shown */
  tdm: Schema.Boolean,
  /** video map ids whose geometry is in the map cache, and ids that failed */
  loaded: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.String),
  /** velocity vector minutes: 0, 1, 2, 4 or 8 */
  vector: Schema.Number,
  /** default leader length 0..3 */
  leader: Schema.Number,
  blocks: Schema.Record(Schema.String, BlockState),
  /** route displays by callsign: the sim time they clear at */
  routes: Schema.Record(Schema.String, Schema.Number),
  /** the MCA's feedback line and the Response Area */
  feedback: Schema.NullOr(Feedback),
  response: Schema.Array(Schema.String),
  menuOpen: Schema.Boolean,
})
export type EramModel = typeof EramModel.Type

export const DEFAULT_RANGE_NM = 150
/** the ARTCC-wide nav reaches about 500 nm; the view may show the whole of it */
export const MAX_RANGE_NM = 700
export const VECTOR_MINUTES: ReadonlyArray<number> = [0, 1, 2, 4, 8]
export const LEADER_PX: ReadonlyArray<number> = [0, 14, 26, 40]
export const ROUTE_DISPLAY_S = 30
export const RESPONSE_LINES = 12
export const HALO_NM = 5

export const initialEram: EramModel = {
  width: 400,
  height: 400,
  view: rangeView(DEFAULT_RANGE_NM),
  drag: null,
  geoMap: null,
  filters: [],
  tdm: false,
  loaded: [],
  failed: [],
  vector: 1,
  leader: 1,
  blocks: {},
  routes: {},
  feedback: null,
  response: [],
  menuOpen: false,
}

/** The GeoMap an ARTCC opens on: the remembered one, else the first. */
export const initialGeoMap = (artcc: ArtccFile | null, remembered: string | null): GeoMap | null =>
  artcc === null ? null : (artcc.geoMaps.find((g) => g.id === remembered) ?? artcc.geoMaps[0] ?? null)

/** Every filter of a GeoMap is on by default, as CRC opens a fresh ERAM. */
export const defaultFilters = (geoMap: GeoMap | null): ReadonlyArray<number> =>
  geoMap === null ? [] : geoMap.filters.flatMap((label, i) => (label[0] === '' && label[1] === '' ? [] : [i + 1]))

export const geoMapById = (artcc: ArtccFile | null, id: string | null): GeoMap | null =>
  artcc === null || id === null ? null : (artcc.geoMaps.find((g) => g.id === id) ?? null)

/** The maps of a GeoMap that the display needs: every non-TDM one, plus the TDM ones in Top-Down mode. */
export const mapsToShow = (geoMap: GeoMap | null, tdm: boolean): ReadonlyArray<string> =>
  geoMap === null ? [] : geoMap.maps.filter((m) => tdm || !m.tdm).map((m) => m.id)

// MESSAGE

export const EramMessage = defineMessageUnion({
  Resized: { width: Schema.Number, height: Schema.Number },
  Wheeled: { x: Schema.Number, y: Schema.Number, deltaY: Schema.Number },
  Pressed: { x: Schema.Number, y: Schema.Number },
  /** a right-click (the pane shares StarsSurface): only the drag the press started is dropped; ERAM has no command ring */
  Context: { x: Schema.Number, y: Schema.Number },
  Moved: { x: Schema.Number, y: Schema.Number },
  Released: { x: Schema.Number, y: Schema.Number },
  ClickedRangeIn: {},
  ClickedRangeOut: {},
  ClickedCentre: {},
  ClickedMenu: {},
  PressedOutsideMenu: {},
  PickedGeoMap: { id: Schema.String },
  ToggledFilter: { index: Schema.Number },
  ToggledTdm: {},
  ClickedVector: {},
  ClickedLeader: {},
  ClickedClearResponse: {},
  CompletedLoadMap: { id: Schema.String },
  FailedLoadMap: { id: Schema.String, error: Schema.String },
  /** an ERAM display entry from the command line (see `DisplayCommand`) */
  Displayed: { callsign: Schema.NullOr(Schema.String), display: DisplayCommand, simTime: Schema.Number },
  /** what the MCA answers, and lines for the Response Area */
  Answered: { ok: Schema.Boolean, text: Schema.String },
  Responded: { lines: Schema.Array(Schema.String) },
})
export type EramMessage = typeof EramMessage.Type

export const EramOut = defineTaggedUnion({
  SelectedTarget: { callsign: Schema.String },
  Noted: { text: Schema.String },
  /** the GeoMap or its filters changed; the parent remembers them per ARTCC */
  ChangedGeoMap: { geoMap: Schema.String, filters: Schema.Array(Schema.Number) },
})
export type EramOut = typeof EramOut.Type

// COMMAND

export const LoadEramMap = Command.define('LoadEramMap', {
  args: { artcc: Schema.String, id: Schema.String },
  messages: [EramMessage.CompletedLoadMap, EramMessage.FailedLoadMap],
  execute: ({ artcc, id }) =>
    Effect.gen(function* () {
      const maps = yield* VideoMaps
      storeVideoMap(yield* maps.load(artcc, id))
      return EramMessage.CompletedLoadMap({ id })
    }).pipe(Effect.catch((e) => Effect.succeed(EramMessage.FailedLoadMap({ id, error: e.message })))),
})

// INIT / UPDATE

export type EramInput = Readonly<{ message: EramMessage; world: World | null; artcc: ArtccFile | null }>

export type EramReturn = Update.ReturnWithOutMessage<EramModel, EramMessage, EramOut, VideoMaps>

const loadCommands = (model: EramModel, artccId: string, ids: ReadonlyArray<string>) =>
  ids.filter((id) => !model.loaded.includes(id) && !model.failed.includes(id)).map((id) => LoadEramMap({ artcc: artccId, id }))

/** A fresh display for an ARTCC: the remembered (else first) GeoMap with its remembered (else every) filter, its maps loading. */
export const eramInit = (
  model: EramModel,
  artcc: ArtccFile | null,
  range: number = DEFAULT_RANGE_NM,
  remembered: Readonly<{ geoMap: string; filters: ReadonlyArray<number> }> | null = null,
): Update.Return<EramModel, EramMessage, VideoMaps> => {
  const geoMap = initialGeoMap(artcc, remembered?.geoMap ?? null)
  const filters = remembered !== null && geoMap !== null && geoMap.id === remembered.geoMap ? remembered.filters : defaultFilters(geoMap)
  const next: EramModel = { ...initialEram, width: model.width, height: model.height, loaded: model.loaded, view: rangeView(range), geoMap: geoMap?.id ?? null, filters, vector: model.vector, leader: model.leader }
  return { model: next, commands: artcc === null ? [] : loadCommands(next, artcc.id, mapsToShow(geoMap, false)) }
}

const blockOf = (model: EramModel, callsign: string): BlockState => model.blocks[callsign] ?? defaultBlock

const withBlock = (model: EramModel, callsign: string, f: (b: BlockState) => BlockState): EramModel =>
  evo(model, { blocks: (blocks) => ({ ...blocks, [callsign]: f(blockOf(model, callsign)) }) })

const answered = (model: EramModel, ok: boolean, text: string): EramModel => evo(model, { feedback: () => ({ ok, text }) })

/** Apply a display entry; the feedback line says what ERAM did. */
export const applyDisplay = (model: EramModel, artcc: ArtccFile | null, callsign: string | null, display: DisplayCommand, simTime: number): EramReturn => {
  const need = (f: (c: string) => EramReturn): EramReturn => (callsign === null ? { model: answered(model, false, 'FLID REQUIRED') } : f(callsign))
  return DisplayCommand.match<EramReturn>(display, {
    ToggleBlock: () =>
      need((c) => ({ model: answered(withBlock(model, c, (b) => ({ ...b, fdb: b.fdb === null ? false : !b.fdb })), true, 'ACCEPT'), outMessage: EramOut.SelectedTarget({ callsign: c }) })),
    PositionBlock: ({ position, leader }) =>
      need((c) => ({ model: answered(withBlock(model, c, (b) => ({ ...b, position: position ?? b.position, leader: leader ?? b.leader })), true, 'ACCEPT') })),
    ToggleVci: () => need((c) => ({ model: answered(withBlock(model, c, (b) => ({ ...b, vci: b.vci === null ? false : !b.vci })), true, 'ACCEPT') })),
    ToggleHalo: () => need((c) => ({ model: answered(withBlock(model, c, (b) => ({ ...b, halo: !b.halo })), true, 'ACCEPT') })),
    ToggleHsf: () => need((c) => ({ model: answered(withBlock(model, c, (b) => ({ ...b, hsf: !b.hsf })), true, 'ACCEPT') })),
    RouteDisplay: ({ minutes }) =>
      need((c) => {
        const shown = model.routes[c] !== undefined && model.routes[c]! > simTime
        if (minutes === null && shown) {
          const { [c]: _, ...rest } = model.routes
          return { model: answered(evo(model, { routes: () => rest }), true, 'ACCEPT') }
        }
        return { model: answered(evo(model, { routes: (r) => ({ ...r, [c]: simTime + ROUTE_DISPLAY_S }) }), true, 'ACCEPT') }
      }),
    ClearRoutes: () => ({ model: answered(evo(model, { routes: () => ({}) }), true, 'ACCEPT') }),
    GeoMap: ({ name }) => {
      if (artcc === null) {
        return { model: answered(model, false, 'NO GEOMAPS') }
      }
      if (name === null) {
        return { model: answered(evo(model, { response: () => artcc.geoMaps.map((g) => `${g.name} ${g.label.join(' ')}`.trim()).slice(0, RESPONSE_LINES) }), true, 'ACCEPT') }
      }
      const target = artcc.geoMaps.find((g) => g.name.toUpperCase() === name || g.label.join('').replace(/\s+/g, '') === name.replace(/\s+/g, ''))
      if (target === undefined) {
        return { model: answered(model, false, `NO GEOMAP ${name}`) }
      }
      const picked = pickGeoMap(model, artcc, target.id)
      return { ...picked, model: answered(picked.model, true, 'ACCEPT') }
    },
  })
}

const pickGeoMap = (model: EramModel, artcc: ArtccFile, id: string): EramReturn => {
  const geoMap = geoMapById(artcc, id)
  if (geoMap === null) {
    return { model }
  }
  const filters = defaultFilters(geoMap)
  const next = evo(model, { geoMap: () => id, filters: () => filters, menuOpen: () => false })
  return { model: next, commands: loadCommands(next, artcc.id, mapsToShow(geoMap, next.tdm)), outMessage: EramOut.ChangedGeoMap({ geoMap: id, filters }) }
}

export const eramUpdate = (model: EramModel, input: EramInput): EramReturn => {
  const artcc = input.artcc
  return EramMessage.match<EramReturn>(input.message, {
    Resized: ({ width, height }) => ({ model: evo(model, { width: () => width, height: () => height }) }),

    Wheeled: ({ x, y, deltaY }) => ({ model: evo(model, { view: () => zoomAt(model, x, y, deltaY > 0 ? 1.13 : 0.885, 2 * MAX_RANGE_NM) }) }),

    Pressed: ({ x, y }) => ({ model: evo(model, { drag: () => ({ startX: x, startY: y, viewX: model.view.x, viewY: model.view.y, moved: false }) }) }),

    Context: () => ({ model: evo(model, { drag: () => null }) }),

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
        ? { model: released, outMessage: EramOut.SelectedTarget({ callsign: best }) }
        : { model: released }
    },

    ClickedRangeIn: () => ({ model: evo(model, { view: (view) => rangeView(Math.max(MIN_RANGE_NM, Math.round(view.w / 2 / 1.5))) }) }),
    ClickedRangeOut: () => ({ model: evo(model, { view: (view) => rangeView(Math.min(MAX_RANGE_NM, Math.round((view.w / 2) * 1.5))) }) }),
    ClickedCentre: () => ({ model: evo(model, { view: () => rangeView(DEFAULT_RANGE_NM) }) }),
    ClickedMenu: () => ({ model: evo(model, { menuOpen: (open) => !open }) }),
    PressedOutsideMenu: () => ({ model: evo(model, { menuOpen: () => false }) }),

    PickedGeoMap: ({ id }) => (artcc === null ? { model } : pickGeoMap(model, artcc, id)),

    ToggledFilter: ({ index }) => {
      const filters = model.filters.includes(index) ? model.filters.filter((i) => i !== index) : [...model.filters, index]
      const next = evo(model, { filters: () => filters })
      return model.geoMap === null ? { model: next } : { model: next, outMessage: EramOut.ChangedGeoMap({ geoMap: model.geoMap, filters }) }
    },

    ToggledTdm: () => {
      const next = evo(model, { tdm: (tdm) => !tdm })
      return artcc === null ? { model: next } : { model: next, commands: loadCommands(next, artcc.id, mapsToShow(geoMapById(artcc, next.geoMap), next.tdm)) }
    },

    ClickedVector: () => ({ model: evo(model, { vector: (v) => VECTOR_MINUTES[(VECTOR_MINUTES.indexOf(v) + 1) % VECTOR_MINUTES.length] ?? 0 }) }),

    ClickedLeader: () => ({ model: evo(model, { leader: (l) => (l + 1) % LEADER_PX.length }) }),

    ClickedClearResponse: () => ({ model: evo(model, { response: () => [], feedback: () => null }) }),

    CompletedLoadMap: ({ id }) => ({ model: evo(model, { loaded: (loaded) => (loaded.includes(id) ? loaded : [...loaded, id]) }) }),

    FailedLoadMap: ({ id, error }) => ({
      model: evo(model, { failed: (failed) => (failed.includes(id) ? failed : [...failed, id]) }),
      outMessage: EramOut.Noted({ text: `GeoMap element ${id.slice(-6)}: ${error}` }),
    }),

    Displayed: ({ callsign, display, simTime }) => applyDisplay(model, artcc, callsign, display, simTime),

    Answered: ({ ok, text }) => ({ model: answered(model, ok, text) }),

    Responded: ({ lines }) => ({ model: evo(model, { response: (r) => [...lines, ...r].slice(0, RESPONSE_LINES) }) }),
  })
}

export const someEram = (model: EramModel): Option.Option<EramModel> => Option.some(model)

/** The route displays still running at a sim time. */
export const routesShown = (model: EramModel, simTime: number): ReadonlyArray<string> =>
  Object.entries(model.routes)
    .filter(([, until]) => until > simTime)
    .map(([callsign]) => callsign)
