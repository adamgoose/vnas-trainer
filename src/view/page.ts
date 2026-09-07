import type { Document, HtmlBuilder } from 'foldkit/html'

import { Message } from '../app/message'
import { type Model, infoOf, worldOf } from '../app/model'
import { positionLabel } from '../app/update'
import { positionFor } from '../positions'
import { deckView } from './deck'
import { dialogView } from './dialogs'
import { headerView } from './header'
import { accentFor, scopeView } from './scope'
import { starsView } from './stars'
import { stripsView } from './strips'

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const info = infoOf(model)
  const label = positionLabel(model.settings.mode)
  const position = positionFor(model.settings.mode)
  const pane = !position.hasRadar ? 'ground' : !position.groundScope ? 'stars' : model.settings.view
  const radar = h.submodel({
    slotId: 'stars',
    model: model.stars,
    view: starsView,
    viewInputs: { world: worldOf(model), stars: info?.stars ?? null, selected: model.selected, devicePixelRatio: model.devicePixelRatio, accent: accentFor(model.settings.mode) },
    toParentMessage: (message) => Message.GotStars({ message }),
  })
  return {
    title: info === null ? `vNAS ${label} Trainer` : `${info.id} · vNAS ${label} Trainer`,
    body: h.div(
      [h.Class(`app ${model.settings.mode}`)],
      [
        headerView(model, h),
        h.main([], [h.div([h.Class(`scopes ${pane}`)], [pane === 'stars' ? h.empty : scopeView(model, h), pane === 'ground' ? h.empty : radar]), stripsView(model, h)]),
        deckView(model, h),
        dialogView(model, h),
      ],
    ),
  }
}
