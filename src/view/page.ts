import type { Document, HtmlBuilder } from 'foldkit/html'

import { SplitHandle } from '../app/commands'
import { Message } from '../app/message'
import { type Model, infoOf, worldOf } from '../app/model'
import { positionLabel } from '../app/update'
import { positionFor } from '../positions'
import { deckView } from './deck'
import { dialogView } from './dialogs'
import { headerView } from './header'
import { accentFor, scopeView } from './scope'
import { starsView } from './stars'
import { selectedStripView, stripsView } from './strips'

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
  const split = model.settings.split
  const scopes = h.div(
    [h.Class(`scopes ${pane}`), ...(pane === 'both' ? [h.Style({ gridTemplateColumns: `minmax(0, ${split}fr) auto minmax(0, ${1 - split}fr)` })] : [])],
    [
      pane === 'stars' ? h.empty : scopeView(model, h, selectedStripView(model, h)),
      pane === 'both'
        ? h.div([h.Class('splitter'), h.Role('separator'), h.Attribute('aria-orientation', 'vertical'), h.AriaLabel('Resize panes'), h.OnMount(SplitHandle())], [])
        : h.empty,
      pane === 'ground' ? h.empty : radar,
    ],
  )
  return {
    title: info === null ? `vNAS ${label} Trainer` : `${info.id} · vNAS ${label} Trainer`,
    body: h.div(
      [h.Class(`app ${model.settings.mode}`)],
      [
        headerView(model, h),
        h.main([], [scopes, stripsView(model, h)]),
        deckView(model, h),
        dialogView(model, h),
      ],
    ),
  }
}
