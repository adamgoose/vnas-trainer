import type { Html, HtmlBuilder } from 'foldkit/html'

import { Message } from '../app/message'
import { type Model, infoOf, worldOf } from '../app/model'
import { positionLabel } from '../app/update'
import { positionFor } from '../positions'

export const clock = (seconds: number): string =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

const option = (h: HtmlBuilder<Message>, value: string, label: string, selected: boolean): Html =>
  h.option([h.Value(value), h.Selected(selected)], [label])

export const headerView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const world = worldOf(model)
  const info = infoOf(model)
  const index = model.index._tag === 'Ready' ? model.index.index : null
  const currentArtcc = info?.artcc ?? index?.artccs[0]?.id ?? ''
  const airports = index?.artccs.find((a) => a.id === currentArtcc)?.airports ?? []
  const loadingId = model.airport._tag === 'Loading' ? model.airport.id : null
  const currentAirport = info?.id ?? loadingId ?? ''
  const currentScenario = model.scenarioLoading ?? world?.scenario?.id ?? ''
  return h.header(
    [],
    [
      h.span(
        [h.Class('brand')],
        [
          'vNAS ',
          h.select(
            [h.Class('mode'), h.AriaLabel('Position'), h.Title('Switch position'), h.OnChange((v) => Message.ChangedPosition({ mode: v === 'tower' ? 'tower' : 'ground' }))],
            [option(h, 'ground', 'Ground', model.settings.mode === 'ground'), option(h, 'tower', 'Local', model.settings.mode === 'tower')],
          ),
          ' Trainer',
          h.small([], ['ATCTrainer command set']),
        ],
      ),
      h.select(
        [h.AriaLabel('ARTCC'), h.Disabled(index === null), h.OnChange((id) => Message.ChangedArtcc({ id }))],
        (index?.artccs ?? []).map((a) => option(h, a.id, `${a.id} — ${a.name}`, a.id === currentArtcc)),
      ),
      h.select(
        [h.AriaLabel('Airport'), h.Disabled(index === null), h.OnChange((id) => Message.ChangedAirport({ id }))],
        airports.map((p) => option(h, p.id, `${p.id} — ${p.name}${p.n > 0 ? ` (${p.n})` : ''}`, p.id === currentAirport)),
      ),
      h.select(
        [h.AriaLabel('Scenario'), h.Disabled(info === null), h.OnChange((id) => Message.ChangedScenario({ id }))],
        [
          option(h, '', '— empty field —', currentScenario === ''),
          ...(info?.scenarios ?? []).map((s) => option(h, s.id, `${s.name}${s.count > 0 ? ` — ${s.count}` : ''}`, s.id === currentScenario)),
        ],
      ),
      h.button([h.Class('tbtn'), h.Type('button'), h.OnClick(Message.ClickedHelp())], ['Commands']),
      h.button([h.Class('tbtn'), h.Type('button'), h.OnClick(Message.ClickedSettings())], ['Settings']),
      h.div(
        [h.Class('clock')],
        [
          h.span([], ['T+', h.b([], [clock(world?.simTime ?? 0)])]),
          h.button([h.Class('tbtn'), h.Type('button'), h.AriaPressed(model.running ? 'true' : 'false'), h.OnClick(Message.ClickedTogglePlay())], [model.running ? 'Running' : 'Paused']),
          h.button([h.Class('tbtn'), h.Type('button'), h.OnClick(Message.ClickedRate())], [`${model.rate}×`]),
          h.button([h.Class('tbtn'), h.Type('button'), h.AriaPressed(world?.arrivalsEnabled ? 'true' : 'false'), h.OnClick(Message.ClickedArrivals())], ['Arrivals']),
          positionFor(model.settings.mode).hasRadar
            ? h.div(
                [h.Class('viewbar'), h.Role('group'), h.AriaLabel('Panes')],
                (['ground', 'both', 'stars'] as const).map((view) =>
                  h.button([h.Type('button'), h.AriaPressed(model.settings.view === view ? 'true' : 'false'), h.OnClick(Message.ClickedPane({ view }))], [view === 'ground' ? 'ASDE-X' : view === 'both' ? 'Both' : 'STARS']),
                ),
              )
            : h.span([h.Class('position-note')], [positionLabel(model.settings.mode)]),
        ],
      ),
    ],
  )
}
