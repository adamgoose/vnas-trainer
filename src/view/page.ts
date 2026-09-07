/**
 * The page: the bar, then the workspace with the position's layout drawn as
 * nested flex splits with gutters, the floating windows over it, or one window
 * filling it. Every display is a window (see `app/layout.ts`).
 */
import type { Document, Html, HtmlBuilder } from 'foldkit/html'

import { DragHandle, WorkspaceSurface } from '../app/commands'
import { type Dir, type Layout, type Node, type Panel, availablePanels, isOpen, prune } from '../app/layout'
import { Message } from '../app/message'
import { type Model, infoOf, worldOf } from '../app/model'
import { activeLayout, positionLabel } from '../app/update'
import { barView } from './bar'
import { controlsView } from './controls'
import { deckView } from './deck'
import { helpView, sessionView, settingsView } from './dialogs'
import { accentFor, scopeView } from './scope'
import { starsView } from './stars'
import { scenariosView } from './scenarios'
import { selectedStripView, stripsView } from './strips'
import { timelineView } from './timeline'
import { type WindowMode, windowView } from './window'

const titleOf = (model: Model, panel: Panel): string => {
  const info = infoOf(model)
  const world = worldOf(model)
  switch (panel) {
    case 'asdex':
      return `ASDE-X${info === null ? '' : ` · ${info.id}`}`
    case 'stars':
      return `STARS${info?.stars === null || info === null ? '' : ` · ${info.stars.host}`}`
    case 'strips':
      return `Strips${world === null ? '' : ` · ${world.aircraft.filter((a) => a.delay <= 0).length}`}`
    case 'console':
      return 'Console'
    case 'controls':
      return 'Controls'
    case 'scenarios':
      return `Scenarios${info === null ? '' : ` · ${info.id}`}`
    case 'rewind':
      return 'Rewind'
    case 'commands':
      return 'Command reference'
    case 'settings':
      return 'Settings'
    case 'session':
      return 'Shared session'
  }
}

const contentOf = (model: Model, h: HtmlBuilder<Message>, panel: Panel): Html => {
  switch (panel) {
    case 'controls':
      return controlsView(model, h)
    case 'scenarios':
      return scenariosView(model, h)
    case 'asdex':
      return scopeView(model, h, selectedStripView(model, h))
    case 'stars':
      return h.submodel({
        slotId: 'stars',
        model: model.stars,
        view: starsView,
        viewInputs: { world: worldOf(model), stars: infoOf(model)?.stars ?? null, selected: model.selected, devicePixelRatio: model.devicePixelRatio, accent: accentFor(model.settings.mode) },
        toParentMessage: (message) => Message.GotStars({ message }),
      })
    case 'strips':
      return stripsView(model, h)
    case 'console':
      return deckView(model, h)
    case 'rewind':
      return timelineView(model, h)
    case 'commands':
      return helpView(h)
    case 'settings':
      return settingsView(model, h)
    case 'session':
      return sessionView(model, h)
  }
}

/** Keyed by place, so a gutter that moves in the tree is a fresh element with fresh Mount args (a Mount captures its args once). */
const gutter = (h: HtmlBuilder<Message>, path: ReadonlyArray<number>, index: number, dir: Dir): Html =>
  h.keyed('div')(
    `gutter:${dir}:${path.join('.')}:${index}`,
    [
      h.Class(`gutter ${dir}`),
      h.Role('separator'),
      h.Attribute('aria-orientation', dir === 'row' ? 'vertical' : 'horizontal'),
      h.AriaLabel('Resize'),
      h.OnMount(DragHandle({ kind: 'gutter', key: path.join('.'), index, dir, grip: null })),
    ],
    [],
  )

const tiles = (model: Model, h: HtmlBuilder<Message>, node: Node, path: ReadonlyArray<number>, size: number): Html => {
  if (node._tag === 'Leaf') {
    return windowView(model, h, node.panel, titleOf(model, node.panel), { kind: 'tiled', size }, contentOf(model, h, node.panel))
  }
  const children = node.children.flatMap((child, i) => [
    ...(i === 0 ? [] : [gutter(h, path, i - 1, node.dir)]),
    tiles(model, h, child, [...path, i], node.sizes[i] ?? 1 / node.children.length),
  ])
  return h.div([h.Class(`split ${node.dir}`), h.Style({ flex: `${size} 1 0%` })], children)
}

const workspace = (model: Model, h: HtmlBuilder<Message>, layout: Layout): ReadonlyArray<Html> => {
  const full = model.fullscreen !== null && isOpen(layout, model.fullscreen) ? model.fullscreen : null
  if (full !== null) {
    return [windowView(model, h, full, titleOf(model, full), { kind: 'full' }, contentOf(model, h, full))]
  }
  return [
    layout.root === null ? h.div([h.Class('empty-workspace')], ['no windows — open one from the bar']) : h.div([h.Class('tiles')], [tiles(model, h, layout.root, [], 1)]),
    ...layout.floating.map((rect) => {
      const mode: WindowMode = { kind: 'floating', rect }
      return windowView(model, h, rect.panel, titleOf(model, rect.panel), mode, contentOf(model, h, rect.panel))
    }),
  ]
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const info = infoOf(model)
  const label = positionLabel(model.settings.mode)
  const layout = prune(activeLayout(model), availablePanels(model.settings.mode))
  return {
    title: info === null ? `vNAS ${label} Trainer` : `${info.id} · vNAS ${label} Trainer`,
    body: h.div(
      [h.Class(`app ${model.settings.mode}${model.windowDrag?.moved === true ? ' window-dragging' : ''}`)],
      [barView(model, h), h.div([h.Class('workspace'), h.OnMount(WorkspaceSurface())], workspace(model, h, layout))],
    ),
  }
}
