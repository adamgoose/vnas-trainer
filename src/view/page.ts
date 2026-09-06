import type { Document, HtmlBuilder } from 'foldkit/html'

import { Message } from '../app/message'
import { type Model, infoOf } from '../app/model'
import { positionLabel } from '../app/update'
import { deckView } from './deck'
import { dialogView } from './dialogs'
import { headerView } from './header'
import { scopeView } from './scope'
import { stripsView } from './strips'

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const info = infoOf(model)
  const label = positionLabel(model.settings.mode)
  return {
    title: info === null ? `vNAS ${label} Trainer` : `${info.id} · vNAS ${label} Trainer`,
    body: h.div(
      [h.Class(`app ${model.settings.mode}`)],
      [
        headerView(model, h),
        h.main([], [h.div([h.Class('scopes')], [scopeView(model, h)]), stripsView(model, h)]),
        deckView(model, h),
        dialogView(model, h),
      ],
    ),
  }
}
