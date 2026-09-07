/**
 * The Controls window, a bar the height of its content: position, the loaded
 * airport and scenario (a click opens the Scenarios pane), the clock and the
 * transport (rewind, run, rate, arrivals).
 */
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Message } from '../app/message'
import { type Model, infoOf, isGuest, isReviewing, worldOf } from '../app/model'
import { positionLabel } from '../app/update'

export const clock = (seconds: number): string =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

const option = (h: HtmlBuilder<Message>, value: string, label: string, selected: boolean): Html =>
  h.option([h.Value(value), h.Selected(selected)], [label])

export const controlsView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const world = worldOf(model)
  const info = infoOf(model)
  const loadingId = model.airport._tag === 'Loading' ? model.airport.id : null
  const currentAirport = info?.id ?? loadingId ?? ''
  const currentScenario = model.scenarioLoading ?? world?.scenario?.id ?? ''
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
              h.Class(`tbtn rewind${isReviewing(model) ? ' rewound' : ''}`),
              h.Type('button'),
              h.Disabled(world === null || isGuest(model)),
              h.Title(isGuest(model) ? 'The host owns the clock; rewinding is for the host' : 'Rewind through this session and resume from any point as a new branch'),
              h.OnClick(Message.ClickedTimeline()),
            ],
            [isReviewing(model) ? 'Rewound' : 'Rewind'],
          ),
          h.button(
            [h.Class('tbtn'), h.Type('button'), h.AriaPressed(model.running ? 'true' : 'false'), h.Title(isReviewing(model) ? 'Resume from the point shown (forks the timeline)' : ''), h.OnClick(Message.ClickedTogglePlay())],
            [model.running ? 'Running' : isReviewing(model) ? 'Resume' : 'Paused'],
          ),
          h.button([h.Class('tbtn'), h.Type('button'), h.OnClick(Message.ClickedRate())], [`${model.rate}×`]),
          h.button([h.Class('tbtn'), h.Type('button'), h.AriaPressed(world?.arrivalsEnabled ? 'true' : 'false'), h.OnClick(Message.ClickedArrivals())], ['Arrivals']),
          h.span([h.Class('position-note')], [positionLabel(model.settings.mode)]),
        ],
      ),
    ],
  )
}
