/**
 * The bar above the workspace, as i3 has one: the brand, a chip per window the
 * position offers (filled when tiled, outlined when floating, dim when closed;
 * a click opens or closes it), and a reset for the layout.
 */
import type { Html, HtmlBuilder } from 'foldkit/html'

import { PANEL_SPECS, type Panel, availablePanels, placement } from '../app/layout'
import { Message } from '../app/message'
import { type Model, infoOf, isReviewing } from '../app/model'
import { activeLayout } from '../app/update'

const chipLabel = (model: Model, panel: Panel): string => {
  const info = infoOf(model)
  switch (panel) {
    case 'asdex':
      return info === null ? 'ASDE-X' : `ASDE-X ${info.id}`
    case 'session': {
      const s = model.session
      return s.role === 'solo' ? 'Session' : `${s.role === 'host' ? 'Hosting' : 'Joined'} ${s.room ?? ''} · ${s.peers.length}`
    }
    case 'rewind':
      return isReviewing(model) ? 'Rewound' : 'Rewind'
    default:
      return PANEL_SPECS[panel].title
  }
}

export const barView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const layout = activeLayout(model)
  return h.div(
    [h.Class('bar'), h.Role('toolbar'), h.AriaLabel('Windows')],
    [
      h.span([h.Class('brand')], ['vNAS Trainer', h.small([], ['ATCTrainer command set'])]),
      h.div(
        [h.Class('chips')],
        availablePanels(model.settings.mode).map((panel) => {
          const where = placement(layout, panel)
          const extra = panel === 'session' ? ` session-chip ${model.session.status}` : panel === 'rewind' && isReviewing(model) ? ' rewound' : ''
          return h.button(
            [
              h.Type('button'),
              h.Class(`chip ${where ?? 'closed'}${extra}`),
              h.AriaPressed(where === null ? 'false' : 'true'),
              h.Title(where === null ? `Open ${PANEL_SPECS[panel].title}` : `Close ${PANEL_SPECS[panel].title} (${where})`),
              h.OnClick(Message.ToggledWindow({ panel })),
            ],
            [chipLabel(model, panel)],
          )
        }),
      ),
      h.button([h.Type('button'), h.Class('chip reset'), h.Title('Restore the default layout for this position'), h.OnClick(Message.ClickedResetLayout())], ['Reset layout']),
    ],
  )
}
