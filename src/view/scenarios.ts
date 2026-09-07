/**
 * The Scenarios pane: an ARTCC to browse, its airports (a click loads one), and
 * the loaded airport's scenarios with their aircraft counts and a Load button;
 * the one running can be restarted.
 */
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Message } from '../app/message'
import { type Model, type ScenarioSummary, infoOf, isGuest, worldOf } from '../app/model'
import { positionFor } from '../positions'

const scenarioRow = (model: Model, s: ScenarioSummary | null, h: HtmlBuilder<Message>): Html => {
  const world = worldOf(model)
  const id = s?.id ?? ''
  const running = (world?.scenario?.id ?? '') === id && model.scenarioLoading === null
  const loading = model.scenarioLoading === id && id !== ''
  const loadsAirborne = positionFor(model.settings.mode).rules.loadsAirborne
  const usable = s === null ? 0 : loadsAirborne ? s.count : s.surface
  const counts = s === null ? 'no aircraft' : `${s.surface} surface · ${s.airborne} airborne`
  return h.keyed('div')(
    id === '' ? '·empty' : id,
    [h.Class(`sc-row${running ? ' running' : ''}${s !== null && usable === 0 ? ' unusable' : ''}`), h.AriaSelected(running)],
    [
      h.div([h.Class('sc-name')], [s === null ? 'Empty field' : s.name]),
      h.div([h.Class('sc-counts')], [counts, s !== null && usable === 0 ? ' · nothing for this position' : '']),
      h.button(
        [h.Type('button'), h.Class('tbtn sc-load'), h.AriaPressed(running ? 'true' : 'false'), h.Disabled(loading), h.Title(isGuest(model) ? 'Asks the host to load it' : ''), h.OnClick(Message.ChangedScenario({ id }))],
        [loading ? 'loading…' : running ? 'Restart' : 'Load'],
      ),
    ],
  )
}

export const scenariosView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const info = infoOf(model)
  const index = model.index._tag === 'Ready' ? model.index.index : null
  const loadingId = model.airport._tag === 'Loading' ? model.airport.id : null
  const loadedId = info?.id ?? loadingId ?? null
  const artccId = model.browseArtcc ?? info?.artcc ?? index?.artccs[0]?.id ?? ''
  const artcc = index?.artccs.find((a) => a.id === artccId)
  return h.div(
    [h.Class('scenarios')],
    [
      h.div(
        [h.Class('sc-airports')],
        [
          h.select(
            [h.AriaLabel('ARTCC'), h.Disabled(index === null), h.OnChange((id) => Message.ChangedArtcc({ id }))],
            (index?.artccs ?? []).map((a) => h.option([h.Value(a.id), h.Selected(a.id === artccId)], [`${a.id} — ${a.name}`])),
          ),
          h.div(
            [h.Class('sc-list')],
            (artcc?.airports ?? []).map((p) =>
              h.keyed('button')(
                p.id,
                [
                  h.Type('button'),
                  h.Class(`sc-airport${p.id === loadedId ? ' loaded' : ''}`),
                  h.AriaSelected(p.id === loadedId),
                  h.Title(p.id === loadingId ? 'loading…' : `Load ${p.id} with its first scenario`),
                  h.OnClick(Message.ChangedAirport({ id: p.id })),
                ],
                [h.b([], [p.id]), h.span([], [p.name]), h.i([], [p.id === loadingId ? 'loading…' : p.n > 0 ? `${p.n}` : ''])],
              ),
            ),
          ),
        ],
      ),
      h.div(
        [h.Class('sc-scenarios')],
        info === null
          ? [h.div([h.Class('sc-empty')], [loadingId === null ? 'pick an airport' : `loading ${loadingId}…`])]
          : [
              h.div([h.Class('aside-h')], [h.span([], [`${info.id} · ${info.name}`]), h.b([], [`${info.scenarios.length} scenarios`])]),
              h.div([h.Class('sc-list')], [scenarioRow(model, null, h), ...info.scenarios.map((s) => scenarioRow(model, s, h))]),
            ],
      ),
    ],
  )
}
