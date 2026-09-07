/**
 * One window: a title bar that drags (a floating window moves; any window
 * dropped on the side of a tile docks there), buttons to float or tile, fill
 * the workspace and close, the panel's content, resize grips when floating,
 * and the drop hint while another window is dragged over this one.
 */
import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { DragHandle } from '../app/commands'
import { type Edge, type Floating, PANEL_SPECS, type Panel } from '../app/layout'
import { Message } from '../app/message'
import type { Model } from '../app/model'

export type WindowMode = Readonly<{ kind: 'tiled'; size: number }> | Readonly<{ kind: 'floating'; rect: Floating }> | Readonly<{ kind: 'full' }>

const button = (h: HtmlBuilder<Message>, label: string, title: string, message: Message, pressed = false): Html =>
  h.button([h.Type('button'), h.Class('win-btn'), h.Title(title), h.AriaPressed(pressed ? 'true' : 'false'), h.OnClick(message)], [label])

const dropHint = (model: Model, panel: Panel, h: HtmlBuilder<Message>): Html => {
  const drag = model.windowDrag
  const edge: Edge | null = drag !== null && drag.over === panel ? drag.edge : null
  return edge === null ? h.empty : h.div([h.Class(`drop-hint ${edge}`)], [])
}

const grips = (panel: Panel, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  (['right', 'bottom', 'corner'] as const).map((grip) =>
    h.i([h.Class(`grip ${grip}`), h.OnMount(DragHandle({ kind: 'resize', key: panel, index: 0, dir: null, grip }))], []),
  )

export const windowView = (model: Model, h: HtmlBuilder<Message>, panel: Panel, title: string, mode: WindowMode, content: Html): Html => {
  const dragging = model.windowDrag?.panel === panel && model.windowDrag.moved
  /** a bar: its content is its height; tiled, a gutter cannot go below it, floating, the stored height is only a minimum */
  const fixed = PANEL_SPECS[panel].fixed && mode.kind !== 'full'
  const style =
    mode.kind === 'tiled'
      ? { flex: `${mode.size} 1 0%` }
      : mode.kind === 'floating'
        ? { left: `${mode.rect.x}px`, top: `${mode.rect.y}px`, width: `${mode.rect.w}px`, [fixed ? 'minHeight' : 'height']: `${mode.rect.h}px` }
        : {}
  return h.keyed('div')(
    panel,
    [
      h.Class(`win ${mode.kind}${fixed ? ' fixed' : ''}${dragging ? ' dragging' : ''}`),
      h.Attribute('data-panel', panel),
      h.Style(style),
      ...(mode.kind === 'floating' ? [h.OnPointerDown(() => Option.some(Message.FocusedWindow({ panel })))] : []),
    ],
    [
      h.div(
        [
          h.Class('win-title'),
          h.Title(mode.kind === 'floating' ? 'Drag to move · Shift-drag onto a tile to dock there' : 'Drag onto another tile to move this window there'),
          h.OnMount(DragHandle({ kind: 'window', key: panel, index: 0, dir: null, grip: null })),
        ],
        [
          h.span([h.Class('win-name')], [title]),
          button(h, mode.kind === 'floating' ? '⊞' : '⧉', mode.kind === 'floating' ? 'Tile this window' : 'Float this window', Message.ToggledFloat({ panel }), mode.kind === 'floating'),
          button(h, '⛶', mode.kind === 'full' ? 'Back to the layout (Esc)' : 'Fill the workspace', Message.ToggledFullscreen({ panel }), mode.kind === 'full'),
          button(h, '×', `Close ${PANEL_SPECS[panel].title}`, Message.ClosedWindow({ panel })),
        ],
      ),
      h.div([h.Class('win-body')], [content]),
      dropHint(model, panel, h),
      ...(mode.kind === 'floating' ? grips(panel, h) : []),
    ],
  )
}
