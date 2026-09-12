/**
 * The Controls window, a bar the height of its content: position, the loaded
 * airport and scenario (a click opens the Scenarios pane), the clock and the
 * transport (rewind, play/pause, the rate picker, arrivals).
 */
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Message } from '../app/message'
import { type Model, infoOf, isGuest, isReviewing, worldOf } from '../app/model'

export const clock = (seconds: number): string =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

/** the rates the picker offers; a rate typed with SIMRATE that is not one of them is added while it is current */
export const RATE_OPTIONS: ReadonlyArray<number> = [1, 2, 4, 8]

const PLAY = 'M3 2 L14 8 L3 14 Z'
const PAUSE = 'M3 2h4v12H3z M9 2h4v12H9z'
const REWIND = 'M2 2h2v12H2z M14 2 L5 8 L14 14 Z'

const icon = (h: HtmlBuilder<Message>, d: string): Html =>
  h.svg([h.Class('icon'), h.ViewBox('0 0 16 16'), h.Attribute('width', '10'), h.Attribute('height', '10'), h.Attribute('aria-hidden', 'true')], [h.path([h.D(d)])])

const option = (h: HtmlBuilder<Message>, value: string, label: string, selected: boolean): Html =>
  h.option([h.Value(value), h.Selected(selected)], [label])

export const controlsView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const world = worldOf(model)
  const info = infoOf(model)
  const loadingId = model.airport._tag === 'Loading' ? model.airport.id : null
  const currentAirport = info?.id ?? loadingId ?? ''
  const currentScenario = model.scenarioLoading ?? world?.scenario?.id ?? ''
  const reviewing = isReviewing(model)
  const rates = RATE_OPTIONS.includes(model.rate) ? RATE_OPTIONS : [...RATE_OPTIONS, model.rate].sort((a, b) => a - b)
  return h.div(
    [h.Class('controls')],
    [
      h.select(
        [h.Class('mode'), h.AriaLabel('Position'), h.Title('Switch position'), h.OnChange((v) => Message.ChangedPosition({ mode: v === 'tower' ? 'tower' : v === 'tracon' ? 'tracon' : v === 'center' ? 'center' : 'ground' }))],
        [
          option(h, 'ground', 'Ground', model.settings.mode === 'ground'),
          option(h, 'tower', 'Local', model.settings.mode === 'tower'),
          option(h, 'tracon', 'Approach', model.settings.mode === 'tracon'),
          option(h, 'center', 'Center', model.settings.mode === 'center'),
        ],
      ),
      h.button(
        [h.Type('button'), h.Class('tbtn current'), h.Title('Open the Scenarios pane'), h.OnClick(Message.ToggledWindow({ panel: 'scenarios' }))],
        [
          h.b([], [currentAirport === '' ? 'no airport' : currentAirport]),
          currentAirport === '' ? h.empty : h.span([], [` · ${model.scenarioLoading !== null ? 'loading…' : info === null ? 'loading…' : (info.scenarios.find((x) => x.id === currentScenario)?.name ?? 'empty field')}`]),
        ],
      ),
      h.div(
        [h.Class('clock')],
        [
          h.span([], ['T+', h.b([], [clock(world?.simTime ?? 0)])]),
          h.button(
            [
              h.Class(`tbtn rewind${reviewing ? ' rewound' : ''}`),
              h.Type('button'),
              h.Disabled(world === null || isGuest(model)),
              h.Title(isGuest(model) ? 'The host owns the clock; rewinding is for the host' : 'Rewind through this session and resume from any point as a new branch'),
              h.OnClick(Message.ClickedTimeline()),
            ],
            [icon(h, REWIND), reviewing ? 'Rewound' : 'Rewind'],
          ),
          h.button(
            [
              h.Class(`tbtn play${model.running ? '' : ' paused'}`),
              h.Type('button'),
              h.Title(model.running ? 'Pause the simulation' : reviewing ? 'Resume from the point shown (forks the timeline)' : 'Run the simulation'),
              h.OnClick(Message.ClickedTogglePlay()),
            ],
            [icon(h, model.running ? PAUSE : PLAY), model.running ? 'Pause' : reviewing ? 'Resume' : 'Play'],
          ),
          h.select(
            [h.Class('rate'), h.AriaLabel('Simulation rate'), h.Title('Simulation rate; 0× pauses'), h.OnChange((v) => Message.ChangedRate({ rate: Number(v) || 0 }))],
            [option(h, '0', '0× paused', !model.running), ...rates.map((r) => option(h, String(r), `${r}×`, model.running && model.rate === r))],
          ),
          h.button([h.Class('tbtn'), h.Type('button'), h.AriaPressed(world?.arrivalsEnabled ? 'true' : 'false'), h.Title('Generate arrivals every 70 to 110 s'), h.OnClick(Message.ClickedArrivals())], ['Arrivals']),
        ],
      ),
    ],
  )
}
