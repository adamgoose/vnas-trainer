import { Option } from 'effect'
import { type Html, type HtmlBuilder, createLazy, inertHtml as ih } from 'foldkit/html'

import { COMMAND_INPUT } from '../app/commands'
import type { LogLine } from '../app/log'
import { Message } from '../app/message'
import type { Model } from '../app/model'
import { aiEnabled } from '../app/update'
import { positionFor } from '../positions'
import { clock } from './controls'

const placeholder = (model: Model): string => positionFor(model.settings.mode).placeholder

const hint = (model: Model): Readonly<{ text: string; ai: boolean }> =>
  aiEnabled(model.settings)
    ? { text: `plain English via ${model.settings.model}`, ai: true }
    : { text: 'commands only · add a key in Settings', ai: false }

const PTT_LABEL: Readonly<Record<Model['ptt'], string>> = { idle: 'PTT', tx: 'TX', busy: '…', listen: 'REC' }

/**
 * The whole log, however long the session ran. Nothing in it is interactive, so
 * it builds on the inert builder and is memoised below: a session's worth of
 * lines is rebuilt when a line arrives or the rewound point moves, not on every
 * tick. The column is reversed in CSS, so the newest line (index 0) sits at the
 * bottom.
 */
const logList = (log: ReadonlyArray<LogLine>, pendingAi: string | null): Html =>
  ih.div(
    [ih.Id('log')],
    [
      ...(pendingAi === null ? [] : [ih.div([ih.Class('line ai')], [ih.span([ih.Class('t')], ['']), ih.span([ih.Class('m')], [pendingAi])])]),
      ...log.map((line) =>
        ih.div(
          [ih.Class(`line ${line.kind}`)],
          [
            ih.span([ih.Class('t')], [clock(line.time)]),
            ih.span([ih.Class('m')], [line.who === null ? ih.empty : ih.span([ih.Class('who')], [line.who, ' ']), line.text]),
          ],
        ),
      ),
    ],
  )

const lazyLog = createLazy()

export const deckView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const hintText = hint(model)
  return h.div(
    [h.Class('deck')],
    [
      lazyLog(logList, [model.log, model.pendingAi]),
      h.div(
        [h.Class('cmdbar')],
        [
          h.span([h.Class(`sel${model.selected === null ? ' none' : ''}`)], [model.selected ?? 'no target']),
          h.form(
            [h.Class('cmdform'), h.OnSubmit(Message.SubmittedCommand())],
            [
              h.input([
                h.Id(COMMAND_INPUT.slice(1)),
                h.Autocomplete('off'),
                h.Spellcheck(false),
                h.EnterKeyHint('send'),
                h.Placeholder(placeholder(model)),
                h.Value(model.commandText),
                h.OnInput((value) => Message.UpdatedCommandText({ value })),
                h.OnKeyDownPreventDefault((key) =>
                  key === 'ArrowUp' ? Option.some(Message.PressedHistoryUp()) : key === 'ArrowDown' ? Option.some(Message.PressedHistoryDown()) : Option.none(),
                ),
              ]),
            ],
          ),
          h.span([h.Class(`hint${hintText.ai ? ' ai' : ''}`)], [hintText.text]),
          h.button(
            [h.Class('tbtn tts'), h.Type('button'), h.AriaPressed(model.settings.tts ? 'true' : 'false'), h.Title('Speak pilot transmissions'), h.OnClick(Message.ClickedSpeaker())],
            ['🔊'],
          ),
          h.button(
            [
              h.Class(`tbtn ptt${model.ptt === 'idle' ? '' : ' ' + model.ptt}`),
              h.Type('button'),
              h.Title('Push to talk — hold, or hold Space outside the command box'),
              h.OnPointerDown(() => Option.some(Message.PressedPtt())),
              h.OnPointerUp(() => Option.some(Message.ReleasedPtt())),
              h.OnPointerLeave(() => Option.some(Message.ReleasedPtt())),
            ],
            [PTT_LABEL[model.ptt]],
          ),
        ],
      ),
    ],
  )
}
