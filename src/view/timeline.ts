/**
 * The Rewind window: transport buttons, and the time graph as one lane per
 * branch, a fork hanging under its parent, marks where commands changed the
 * World, and the playhead at the point shown. A press or drag on the lanes goes
 * through the TimelineSurface Mount.
 */
import type { Html, HtmlBuilder } from 'foldkit/html'

import { TimelineSurface } from '../app/commands'
import { Message } from '../app/message'
import { type Model, isGuest, worldOf } from '../app/model'
import { type Point, axisTicks, currentBranch, extent, lanes, liveEnd } from '../app/timeline'
import { SIM_STEP_S } from '../domain/physics'
import { clock } from './controls'

export const LANE_PX = 18

const pct = (fraction: number): string => `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(3)}%`

const transport = (h: HtmlBuilder<Message>, label: string, title: string, message: Message, disabled: boolean): Html =>
  h.button([h.Type('button'), h.Class('tl-btn'), h.Title(title), h.Disabled(disabled), h.OnClick(message)], [label])

export const timelineView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const world = worldOf(model)
  const all = lanes(model.timeline)
  const end = liveEnd(model.timeline)
  if (world === null || end === null || all.length === 0) {
    return h.div([h.Class('timeline')], [h.div([h.Class('tl-bar')], [h.span([h.Class('tl-status')], ['no session to rewind yet'])])])
  }
  const reviewing = model.review !== null
  const guest = isGuest(model)
  const viewed: Point = model.review ?? end
  const e = extent(model.timeline)
  const span = e.end - e.start
  const x = (tick: number): string => pct((tick - e.start) / span)
  const current = currentBranch(model.timeline)
  const viewedBranch = all.find((l) => l.branch.id === viewed.branch)
  const atStart = viewed.tick <= e.start
  const atEnd = viewedBranch !== undefined && viewed.tick >= viewedBranch.branch.endTick
  const continues = reviewing && atEnd
  const rows = all.map(({ branch, row }) => {
    const parentRow = branch.parent === null ? null : all.find((l) => l.branch.id === branch.parent)?.row
    return [
      parentRow === null || parentRow === undefined
        ? h.empty
        : h.i([h.Class('tl-fork'), h.Style({ left: x(branch.forkTick), top: `${parentRow * LANE_PX + LANE_PX / 2}px`, height: `${(row - parentRow) * LANE_PX}px` })]),
      h.div(
        [
          h.Class(`tl-lane${branch.id === model.timeline.current ? ' current' : ''}${branch.id === viewed.branch ? ' viewed' : ''}`),
          h.Title(`branch ${branch.id + 1} · T+${clock(branch.forkTick * SIM_STEP_S)} to T+${clock(branch.endTick * SIM_STEP_S)}`),
          h.Style({ top: `${row * LANE_PX + 5}px`, left: x(branch.forkTick), width: pct((branch.endTick - branch.forkTick) / span) }),
        ],
        [h.span([h.Class('tl-lane-id')], [String(branch.id + 1)])],
      ),
      ...branch.keyframes
        .filter((k) => k.label !== null)
        .map((k) => h.i([h.Class('tl-mark'), h.Title(`T+${clock(k.tick * SIM_STEP_S)} ${k.label ?? ''}`), h.Style({ left: x(k.tick), top: `${row * LANE_PX + 3}px` })])),
    ]
  })
  const status = guest
    ? 'the host owns the clock — rewinding is for the host'
    : reviewing
      ? continues
        ? `at the end of branch ${viewed.branch + 1} — Resume continues it`
        : `rewound to T+${clock(world.simTime)} on branch ${viewed.branch + 1} — Resume forks a new branch here`
      : `live on branch ${(current?.id ?? 0) + 1} — drag the playhead or step back to rewind`
  return h.div(
    [h.Class(`timeline${reviewing ? ' rewound' : ''}`), h.Role('region'), h.AriaLabel('Rewind')],
    [
      h.div(
        [h.Class('tl-bar')],
        [
          transport(h, '⏮', 'To the start', Message.JumpedTimeline({ to: 'start' }), guest || atStart),
          transport(h, '−10s', 'Back ten seconds', Message.SteppedTimeline({ steps: -100 }), guest || atStart),
          transport(h, '−1s', 'Back one second', Message.SteppedTimeline({ steps: -10 }), guest || atStart),
          h.span([h.Class('tl-time')], ['T+', h.b([], [clock(world.simTime)])]),
          transport(h, '+1s', 'Forward one second', Message.SteppedTimeline({ steps: 10 }), guest || !reviewing || atEnd),
          transport(h, '+10s', 'Forward ten seconds', Message.SteppedTimeline({ steps: 100 }), guest || !reviewing || atEnd),
          transport(h, '⏭', 'To the end of this branch', Message.JumpedTimeline({ to: 'end' }), guest || !reviewing || atEnd),
          h.span([h.Class('tl-status')], [status]),
          h.button([h.Type('button'), h.Class('tbtn tl-live'), h.Disabled(!reviewing), h.Title('Return to the present without changing anything'), h.OnClick(Message.ClickedTimelineLive())], ['Live']),
          h.button(
            [h.Type('button'), h.Class('tbtn tl-resume'), h.AriaPressed(reviewing ? 'true' : 'false'), h.Disabled(!reviewing), h.Title(continues ? 'Continue this branch from its end' : 'Fork a new branch here and run on'), h.OnClick(Message.ClickedTimelineResume())],
            [continues ? 'Resume' : 'Resume here'],
          ),
        ],
      ),
      h.div(
        [h.Class('tl-graph')],
        [
          h.div(
            [h.Class('tl-axis')],
            axisTicks(e).map((seconds) => h.span([h.Style({ left: x(seconds / SIM_STEP_S) })], [clock(seconds)])),
          ),
          h.div(
            [h.Class('tl-lanes'), h.Style({ height: `${all.length * LANE_PX}px` }), h.OnMount(TimelineSurface())],
            [
              ...axisTicks(e).map((seconds) => h.i([h.Class('tl-grid'), h.Style({ left: x(seconds / SIM_STEP_S) })])),
              ...rows.flat(),
              h.i([h.Class('tl-head'), h.Style({ left: x(viewed.tick) })]),
            ],
          ),
        ],
      ),
    ],
  )
}
