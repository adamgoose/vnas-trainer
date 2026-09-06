/**
 * The Commands reference and the Settings dialog, rendered as in-page modals
 * over the app (no native <dialog>, so no DOM commands are needed to open them).
 */
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Message } from '../app/message'
import type { Model } from '../app/model'
import type { Settings } from '../services/settings'

const shell = (title: string, body: ReadonlyArray<Html>, footer: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('modal-layer')],
    [
      h.div([h.Class('modal-backdrop'), h.OnClick(Message.ClosedDialog())]),
      h.div(
        [h.Class('modal'), h.Role('dialog'), h.AriaLabel(title)],
        [
          h.div([h.Class('dlg-h')], [h.h2([], [title]), h.button([h.Class('x'), h.Type('button'), h.AriaLabel('Close'), h.OnClick(Message.ClosedDialog())], ['×'])]),
          h.div([h.Class('dlg-b')], body),
          ...(footer.length > 0 ? [h.div([h.Class('dlg-f')], footer)] : []),
        ],
      ),
    ],
  )

const cmdRow = (h: HtmlBuilder<Message>, code: string, text: ReadonlyArray<Html | string>): ReadonlyArray<Html> => [
  h.code([], [code]),
  h.span([], text),
]

export const helpView = (h: HtmlBuilder<Message>): Html =>
  shell(
    'Command reference',
    [
      h.p([], [
        'Select an aircraft on the scope or in the strip list, then type a command — or lead with a callsign the way ATCTrainer\'s CLI does: ',
        h.code([h.Class('inl')], ['1877 PUSH A']), ' matches ', h.b([], ['DAL1877']),
        '. With an OpenRouter key in Settings, plain English works too: anything that isn\'t a recognised command is sent to your chosen model, translated into these commands, and read back by the pilot. Hold ',
        h.b([], ['PTT']), ' (or ', h.b([], ['Space']), ' outside the command box) to say it instead of typing it.',
      ]),
      h.h3([], ['Ground']),
      h.div([h.Class('cmds')], [
        ...cmdRow(h, 'PUSH [taxiway]', ['Push back off the gate onto a taxiway, or straight back.']),
        ...cmdRow(h, 'TAXI {path} [HS {pt}]', ['Taxi via a list of taxiways, e.g. ', h.b([], ['TAXI B A']), '. A gate or spot name may end the path.']),
        ...cmdRow(h, 'RWY {rw} TAXI {path}', ['Taxi to a departure runway, e.g. ', h.b([], ['RWY 30L TAXI A A1']), '. The word TAXI is optional.']),
        ...cmdRow(h, 'HS {taxiway/runway}', ['Hold short of a point already on the route.']),
        ...cmdRow(h, 'CROSS [runway]', ['Cross the runway being held short of.']),
        ...cmdRow(h, 'RES', ['Resume taxi, or cross if holding short.']),
        ...cmdRow(h, 'HOLD', ['Stop where you are.']),
        ...cmdRow(h, 'GIVEWAY {acft}', ['Give way to another aircraft, then continue. Alias ', h.b([], ['GW']), '.']),
        ...cmdRow(h, 'BREAK', ['Ignore ground conflicts for 15 seconds and push through.']),
        ...cmdRow(h, 'TAXIALL', ['Resume every aircraft currently held.']),
      ]),
      h.h3([], ['Tower']),
      h.div([h.Class('cmds')], [
        ...cmdRow(h, 'LUAW', ['Line up and wait on the departure runway.']),
        ...cmdRow(h, 'CTO', ['Cleared for takeoff — rolls, rotates at Vr and climbs runway heading to the airport\'s initial altitude.']),
        ...cmdRow(h, 'CTL', ['Cleared to land. As Local, an arrival without it goes around at one mile.']),
        ...cmdRow(h, 'GA', ['Go around (an arrival still on final).']),
        ...cmdRow(h, 'EXIT [taxiway]', ['Vacate the runway after landing, at a named taxiway or the nearest.']),
        ...cmdRow(h, 'FH {hdg}', ['Fly heading. ', h.b([], ['TL']), ' / ', h.b([], ['TR']), ' force the turn direction.']),
        ...cmdRow(h, 'CM {alt}', ['Climb (or descend) and maintain — feet, hundreds (', h.b([], ['CM 50']), ') or ', h.b([], ['FL230']), '.']),
        ...cmdRow(h, 'CD', ['Contact departure — the pilot switches to the departure frequency and drops off 20 seconds later.']),
      ]),
      h.h3([], ['STARS (Local position)']),
      h.div([h.Class('cmds')], [
        ...cmdRow(h, 'TRACK', ['Start a radar track: the limited data block (beacon + altitude) becomes a full one with callsign, altitude/speed and scratchpad. Alias ', h.b([], ['IC']), '.']),
        ...cmdRow(h, 'DROP', ['Drop the track. Alias ', h.b([], ['DT']), '.']),
      ]),
      h.p([], [
        'Switch the brand dropdown to ', h.b([], ['Local']), ' for the radar pane: range rings, the facility\'s STARS video maps (the tower position\'s DCB list is on by default; ',
        h.b([], ['MAPS']), ' toggles the rest), and one radar return per second with trails. Arrivals check in on frequency, tracked, on a six-mile final and need ',
        h.b([], ['CTL']), '; departures appear as untracked beacon targets once they roll.',
      ]),
      h.h3([], ['Transponder & general']),
      h.div([h.Class('cmds')], [
        ...cmdRow(h, 'SQ {code}', ['Assign a beacon code.']),
        ...cmdRow(h, 'SN / SS / ID', ['Squawk normal, standby, ident.']),
        ...cmdRow(h, 'SAY {gate|type|rwy}', ['Ask the pilot to state something.']),
        ...cmdRow(h, 'DEL', ['Remove the aircraft from the simulation.']),
        ...cmdRow(h, 'PAUSE / UNPAUSE', ['Freeze or resume the clock.']),
        ...cmdRow(h, 'SIMRATE {1-8}', ['Run the clock faster.']),
      ]),
      h.h3([], ['What this does and does not simulate']),
      h.p([], [
        'Aircraft taxi along the facility\'s ', h.b([], ['real ATCTrainer training map']),
        ' — the taxiway centrelines, runways and named parking spots the facility published to vNAS — with intersections merged at the 100-foot tolerance the vNAS spec defines. Routing is a shortest path with a heavy penalty on runway edges, so aircraft prefer to go around rather than across. They hold short of every runway automatically until told to cross, follow each other in trail, and give way at merges. Pavement, where shown, is the facility\'s ASDE-X video map.',
      ]),
      h.p([], [
        'Not simulated: wake turbulence, weather, LAHSO, arrival sequencing on final beyond a simple approach, and the ERAM/STARS side entirely. Scenario aircraft that start airborne are not loaded. Arrivals, when switched on, are generated from the airport\'s own weighted fleet sets as configured in Data Admin, on the runways the scenario\'s generators use.',
      ]),
    ],
    [],
    h,
  )

const field = (h: HtmlBuilder<Message>, id: string, label: string, control: Html, note: string | null = null): ReadonlyArray<Html> => [
  h.label([h.For(id)], [label]),
  control,
  ...(note === null ? [] : [h.small([], [note])]),
]

const textInput = (h: HtmlBuilder<Message>, model: Model, id: string, key: keyof Settings, placeholder: string, type = 'text'): Html =>
  h.input([
    h.Id(id),
    h.Type(type),
    h.Autocomplete('off'),
    h.Placeholder(placeholder),
    h.Value(String(model.draft[key])),
    h.OnInput((value) => Message.UpdatedDraft({ draft: { ...model.draft, [key]: value } })),
  ])

const checkbox = (h: HtmlBuilder<Message>, model: Model, id: string, key: 'tts' | 'radio', note: string): Html =>
  h.div(
    [h.Class('row')],
    [
      h.input([
        h.Id(id),
        h.Type('checkbox'),
        h.Style({ width: 'auto' }),
        h.Checked(model.draft[key]),
        h.OnChange(() => Message.UpdatedDraft({ draft: { ...model.draft, [key]: !model.draft[key] } })),
      ]),
      h.span([h.Class('note')], [note]),
    ],
  )

export const settingsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  shell(
    'Settings',
    [
      h.h3([], ['Plain-English commands · bring your own key']),
      h.p([], [
        'Off by default — the trainer is fully usable with the command syntax alone. Add an ',
        h.a([h.Href('https://openrouter.ai/keys'), h.Target('_blank'), h.Rel('noopener')], ['OpenRouter']),
        ' API key to have any provider/model translate what you\'d say on frequency into ATCTrainer commands. The key is stored only in this browser\'s local storage and sent only to openrouter.ai.',
      ]),
      h.div([h.Class('field')], [
        ...field(h, 's-key', 'OpenRouter API key', textInput(h, model, 's-key', 'key', 'sk-or-v1-…', 'password')),
        ...field(h, 's-model', 'Model', h.div([h.Class('row')], [textInput(h, model, 's-model', 'model', 'anthropic/claude-haiku-4.5'), h.button([h.Class('tbtn'), h.Type('button'), h.Disabled(true), h.Title('Model lists arrive with the AI phase')], ['Load list'])]),
          'Any OpenRouter model id. Fast, cheap models do this job well — the prompt is small and the reply is a few lines of JSON.'),
      ]),
      h.h3([], ['Audio · push-to-talk and pilot voices']),
      h.p([], [
        'Hold the ', h.b([], ['PTT']), ' button (or hold ', h.b([], ['Space']), ' while the command box isn\'t focused), say the transmission, release. With an OpenRouter key, the recording goes to an audio-capable model that transcribes it and translates it into commands in one step. Without a key, the browser\'s own speech recognition is used where available and the words are treated as typed. Pilots read back through the browser\'s speech synthesis by default, or through an OpenRouter speech model.',
      ]),
      h.div([h.Class('field')], [
        ...field(h, 's-audio', 'Audio model', textInput(h, model, 's-audio', 'audioModel', 'google/gemini-3.5-flash-lite'), 'Must accept audio input. Gemini Flash models are fast and cheap for this.'),
        ...field(h, 's-tts', 'Speak pilot transmissions', checkbox(h, model, 's-tts', 'tts', 'readbacks, hold-shorts, ready calls')),
        ...field(h, 's-engine', 'Voice engine', h.select(
          [h.Id('s-engine'), h.OnChange((v) => Message.UpdatedDraft({ draft: { ...model.draft, ttsEngine: v === 'openrouter' ? 'openrouter' : 'browser' } }))],
          [
            h.option([h.Value('browser'), h.Selected(model.draft.ttsEngine === 'browser')], ['Browser speech synthesis (free, offline)']),
            h.option([h.Value('openrouter'), h.Selected(model.draft.ttsEngine === 'openrouter')], ['OpenRouter text-to-speech (uses your key)']),
          ],
        )),
        ...field(h, 's-ttsmodel', 'TTS model', textInput(h, model, 's-ttsmodel', 'ttsModel', 'hexgrad/kokoro-82m'), 'Any OpenRouter speech model. Kokoro is a fraction of a cent per call with many English voices. Priced per character.'),
        ...field(h, 's-voice', 'Pilot voice', h.input([h.Id('s-voice'), h.Type('text'), h.Placeholder('auto — varies per aircraft'), h.Value(model.draft.ttsEngine === 'openrouter' ? model.draft.ttsVoice : model.draft.voice),
          h.OnInput((value) => Message.UpdatedDraft({ draft: model.draft.ttsEngine === 'openrouter' ? { ...model.draft, ttsVoice: value } : { ...model.draft, voice: value } }))]),
          'Voice pickers arrive with the audio phase; a name typed here is kept.'),
        ...field(h, 's-radio', 'Radio effect', checkbox(h, model, 's-radio', 'radio', 'band-limit OpenRouter voices like a VHF receiver')),
      ]),
      h.h3([], ['Data source']),
      h.p([], [
        'By default airports and scenarios come from the ', h.b([], ['catalog']), ' baked into this site (rebuilt from vNAS on a schedule). vNAS\'s own API does not allow browser requests, so to load ',
        h.b([], ['live']), ' from vNAS you need a CORS proxy you control — the repo ships a one-file Cloudflare Worker for that.',
      ]),
      h.div([h.Class('field')], [
        ...field(h, 's-proxy', 'vNAS proxy URL', textInput(h, model, 's-proxy', 'proxy', 'https://vnas-proxy.you.workers.dev/?url='),
          'Leave empty to use the catalog. When set, the vNAS URL is appended (URL-encoded) to this prefix and every airport, map and scenario is fetched live.'),
      ]),
    ],
    [
      h.span([h.Class('status')], [model.settingsStatus]),
      h.button([h.Class('tbtn'), h.Type('button'), h.Disabled(true), h.Title('Arrives with the AI phase')], ['Test key']),
      h.button([h.Class('tbtn'), h.Type('button'), h.Disabled(true), h.Title('Arrives with the audio phase')], ['Test voice']),
      h.button([h.Class('tbtn'), h.Type('button'), h.AriaPressed('true'), h.OnClick(Message.ClickedSaveSettings())], ['Save']),
    ],
    h,
  )

export const dialogView = (model: Model, h: HtmlBuilder<Message>): Html =>
  model.dialog === 'help' ? helpView(h) : model.dialog === 'settings' ? settingsView(model, h) : h.empty
