/**
 * The Commands reference, the Settings form and the Session panel: the contents
 * of their windows, a scrolling body and an optional footer.
 */
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Message } from '../app/message'
import type { Model } from '../app/model'
import { professionalVoices } from '../domain/voices'
import type { Settings } from '../services/settings'

const shell = (title: string, body: ReadonlyArray<Html>, footer: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class('dlg'), h.AriaLabel(title)], [h.div([h.Class('dlg-b')], body), ...(footer.length > 0 ? [h.div([h.Class('dlg-f')], footer)] : [])])

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
      h.p([], [
        'Or click an aircraft on the ground scope for a ring of the commands that fit its state; a marked wedge opens a further ring for the details. The centre goes back, ',
        h.b([], ['Esc']), ' closes. A pick is logged and dispatched as if typed. ', h.b([], ['DISP']), ' on the scope turns the ring off and sets data block size and visibility.',
      ]),
      h.h3([], ['Ground']),
      h.div([h.Class('cmds')], [
        ...cmdRow(h, 'PUSH [taxiway]', ['Push back off the gate onto a taxiway, or straight back.']),
        ...cmdRow(h, 'TAXI {path} [CROSS {rw}] [HS {pt}]', ['Continue a taxi via a list of taxiways, e.g. ', h.b([], ['TAXI B A']), ', to the runway already assigned with RWY (or an arrival to its gate). A gate or spot name may end the path. Aircraft hold short of every runway on the route until cleared across; ', h.b([], ['CROSS 4 12R']), ' in the clearance clears those crossings up front.']),
        ...cmdRow(h, 'RWY {rw} [AT {twy}] TAXI {path}', ['Taxi to a departure runway, e.g. ', h.b([], ['RWY 30L TAXI A A1 CROSS 12R']), '. The word TAXI is optional. ', h.b([], ['AT D']), ' makes it an intersection departure: the aircraft holds short where taxiway D meets the runway, and LUAW and CTO enter there. On the scope, the proposed route marks every taxiway the runway can be entered from; click one to enter there.']),
        ...cmdRow(h, 'HS {taxiway/runway}', ['Hold short of a point already on the route.']),
        ...cmdRow(h, 'CROSS [runway]', ['Cross the runway being held short of, or clear a named runway further along the route.']),
        ...cmdRow(h, 'RES', ['Resume taxi, or cross if holding short.']),
        ...cmdRow(h, 'HOLD', ['Stop where you are.']),
        ...cmdRow(h, 'GIVEWAY {acft}', ['Give way to another aircraft, then continue. Alias ', h.b([], ['GW']), '.']),
        ...cmdRow(h, 'BREAK', ['Ignore ground conflicts for 15 seconds and push through.']),
        ...cmdRow(h, 'TAXIALL', ['Resume every aircraft currently held.']),
      ]),
      h.h3([], ['Tower']),
      h.div([h.Class('cmds')], [
        ...cmdRow(h, 'LUAW [AT {twy}]', ['Line up and wait on the departure runway, at the intersection the taxi clearance named, or at ', h.b([], ['AT D']), '.']),
        ...cmdRow(h, 'CTO [L|R] [hdg] [AT {twy}]', ['Cleared for takeoff — rolls, rotates at Vr and climbs runway heading to the airport\'s initial altitude. With a heading (', h.b([], ['CTO L 250']), ') the pilot turns to it through 400 feet. ', h.b([], ['AT D']), ' names the intersection (the one from the taxi clearance is used otherwise).']),
        ...cmdRow(h, 'CTL', ['Cleared to land. As Local, an arrival without it goes around at one mile.']),
        ...cmdRow(h, 'GA', ['Go around (an arrival still on final).']),
        ...cmdRow(h, 'EXIT [taxiway]', ['Exit the runway at a taxiway: given on final it is taken up at touchdown, on the landing roll it changes the plan; with no taxiway, the first exit the aircraft can slow for. Left alone, an arrival picks the exit that makes the taxi to its gate shortest.']),
        ...cmdRow(h, 'FH {hdg}', ['Fly heading. ', h.b([], ['TL']), ' / ', h.b([], ['TR']), ' force the turn direction.']),
        ...cmdRow(h, 'CM {alt}', ['Climb (or descend) and maintain — feet, hundreds (', h.b([], ['CM 50']), ') or ', h.b([], ['FL230']), '.']),
        ...cmdRow(h, 'CD', ['Contact departure — the pilot switches to the departure frequency and drops off 20 seconds later.']),
      ]),
      h.h3([], ['Approach']),
      h.div([h.Class('cmds')], [
        ...cmdRow(h, 'DM {alt}', ['Descend (or climb) and maintain — the same as ', h.b([], ['CM']), '.']),
        ...cmdRow(h, 'DCT {fix}', ['Proceed direct to a fix; the rest of the route after that fix is kept. Alias ', h.b([], ['PD']), '.']),
        ...cmdRow(h, 'SPD {kt}', ['Assign a speed. ', h.b([], ['SPD']), ' alone resumes normal speed (250 below 10,000).']),
        ...cmdRow(h, 'EXP {rw}', ['Expect a runway — sets the scratchpad and lets ', h.b([], ['CAPP']), ' omit the runway.']),
        ...cmdRow(h, 'CAPP [rw]', ['Cleared for the ILS approach. The aircraft joins the final approach course when it is within about a mile of it and pointed toward the field, tracks it, descends on the 3° path once it meets it, slows to 170 and becomes a 10-mile final that lands itself. Alias ', h.b([], ['ILS']), '.']),
        ...cmdRow(h, 'CT', ['Contact tower — the aircraft stays on the scope until it lands. Alias ', h.b([], ['HO']), '.']),
        ...cmdRow(h, 'CD', ['As Approach, sends a departure to the centre.']),
      ]),
      h.p([], [
        'Switch the brand dropdown to ', h.b([], ['Approach']), ' for the TRACON: scenario aircraft that start airborne fly their STAR or navigation path (fixes and procedures come from vNAS NavData, baked into the catalog), check in on frequency with their altitude, and are yours to descend, slow, vector and clear for the approach; aircraft that start on the field depart one after another and call departure through 1,000 feet. ',
        'The arrival generator spawns aircraft at the entry of a random STAR at 11,000. Select an aircraft to see its remaining route on the scope. Not simulated: published STAR altitudes, holding, visual approaches, separation alerts.',
      ]),
      h.h3([], ['Center (En Route)']),
      h.div([h.Class('cmds')], [
        ...cmdRow(h, 'CM / DM {alt}', ['Climb or descend and maintain; ', h.b([], ['DM FL240']), ' or ', h.b([], ['DM 240']), '.']),
        ...cmdRow(h, 'DCT · SPD · FH', ['Direct, speed and headings as for Approach. Airways on a route are expanded from the ARTCC\'s NavData.']),
        ...cmdRow(h, 'CA', ['Contact approach — the arrival switches to the approach frequency and drops off 20 seconds later.']),
        ...cmdRow(h, 'CD', ['Contact the next centre sector — the one a handoff was started to, if any.']),
      ]),
      h.p([], [
        'ERAM entries are typed the way CRC\'s ERAM takes them, the flight id last (', h.code([h.Class('inl')], ['QZ 240 DAL1234']), '); without a flight id the selected aircraft is used. They change the flight plan and the data block, not what the pilot does — say the clearance (or type the command above) and then key it, as the real position does. The MCA answers ACCEPT or the reason.',
      ]),
      h.div([h.Class('cmds')], [
        ...cmdRow(h, 'QZ {alt} {FLID}', ['Assigned (flight plan) altitude, hundreds of feet: line 2 of the FDB shows it with C (level), ↑ ↓ (climbing or descending to it), + − (through it).']),
        ...cmdRow(h, 'QQ {alt} {FLID}', ['Interim altitude (T in line 2). ', h.b([], ['QQ {FLID}']), ' clears it.']),
        ...cmdRow(h, 'QS {hdg} / QS /{spd} / QS {text} {FLID}', ['Line-4 heading, speed or free text. ', h.b([], ['QS * {FLID}']), ' clears all, ', h.b([], ['QS {FLID}']), ' toggles line 4 between them and the destination.']),
        ...cmdRow(h, 'QU {fix} {FLID}', ['Amend the flight plan route direct to a fix. ', h.b([], ['QU {min} {FLID}']), ' draws the route the aircraft will fly for 30 seconds (', h.b([], ['QU /M']), ' all of it); ', h.b([], ['QU']), ' alone clears every route display.']),
        ...cmdRow(h, 'QT / QX {FLID}', ['Start or drop a track (a full data block).']),
        ...cmdRow(h, 'QF {FLID}', ['Flight plan readout in the Response Area.']),
        ...cmdRow(h, 'QB [code] {FLID}', ['Assign a beacon code, or have one assigned.']),
        ...cmdRow(h, '{sector} {FLID}', ['Start a handoff to a sector of the ARTCC (', h.b([], ['06 DAL1234']), '): field E shows H06, then O06 once the other sector takes it. A bare ', h.b([], ['{FLID}']), ' recalls a handoff not yet taken.']),
        ...cmdRow(h, 'AM {FLID} ALT {alt} / BCN {code}', ['Flight plan amendments (field 8 and 4).']),
        ...cmdRow(h, '{FLID} · {1-9} {FLID} · /{0-3} {FLID} · //{FLID}', ['Display entries: toggle LDB/FDB, position the data block (1 SW … 9 NE), set its leader length, toggle the VCI.']),
        ...cmdRow(h, 'QP J {FLID}', ['Toggle the 5 nm halo.']),
        ...cmdRow(h, 'MR [geomap]', ['List the ARTCC\'s GeoMaps in the Response Area, or switch to one. The toolbar switches GeoMaps and toggles their filters too.']),
      ]),
      h.p([], [
        'Switch the brand dropdown to ', h.b([], ['Center']), ' for the ARTCC on ERAM: the facility\'s GeoMaps and filters as configured in vNAS, targets with history, position symbols and leaders, full data blocks (ACID; assigned and reported altitude; CID and ground speed or the handoff state; destination) for owned tracks and limited ones for the rest, velocity vectors, halos and route displays. Everyone on frequency calls the centre; arrivals are handed to the approach with CA and departures to the next sector with CD. The arrival generator starts aircraft at a STAR entry at FL330.',
      ]),
      h.h3([], ['STARS (Local and Approach positions)']),
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
      h.h3([], ['Rewind and fork']),
      h.p([], [
        h.b([], ['Rewind']),
        ' in the header opens the time graph of this session. Drag the playhead, click a lane, or step back with the buttons: the scopes, strips and log show the session as it was at that moment, with the sim paused. ',
        h.b([], ['Resume here']),
        ' (or the play button) runs on from that point as a new branch; the future you rewound past stays on the graph as its own lane, and clicking it takes you back there. Resuming at the end of a lane continues that branch instead. ',
        h.b([], ['Live']),
        ' returns to the present without changing anything. In a shared session only the host can rewind; guests follow the branch the host resumes.',
      ]),
      h.h3([], ['What this does and does not simulate']),
      h.p([], [
        'Aircraft taxi along the facility\'s ', h.b([], ['real ATCTrainer training map']),
        ' — the taxiway centrelines, runways and named parking spots the facility published to vNAS — with intersections merged at the 100-foot tolerance the vNAS spec defines. Routing is a shortest path with a heavy penalty on runway edges, so aircraft prefer to go around rather than across. They hold short of every runway automatically until told to cross, follow each other in trail, and give way at merges. Pavement, where shown, is the facility\'s ASDE-X video map.',
      ]),
      h.p([], [
        'Not simulated: wake turbulence, weather, LAHSO, arrival sequencing on final beyond a simple approach, conflict alerts, point outs and quick look on ERAM. Arrivals, when switched on, are generated from the airport\'s own weighted fleet sets as configured in Data Admin, on the runways the scenario\'s generators use.',
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

const textInput = (h: HtmlBuilder<Message>, model: Model, id: string, key: keyof Settings, placeholder: string, type = 'text', list: string | null = null): Html =>
  h.input([
    h.Id(id),
    h.Type(type),
    h.Autocomplete('off'),
    h.Placeholder(placeholder),
    h.Value(String(model.draft[key])),
    ...(list === null ? [] : [h.List(list)]),
    h.OnInput((value) => Message.UpdatedDraft({ draft: { ...model.draft, [key]: value } })),
  ])

const datalist = (h: HtmlBuilder<Message>, id: string, ids: ReadonlyArray<string>): Html =>
  h.datalist([h.Id(id)], ids.map((value) => h.option([h.Value(value)], [])))

const voiceSelect = (h: HtmlBuilder<Message>, model: Model): Html => {
  const draft = model.draft
  if (draft.ttsEngine === 'browser') {
    return h.select(
      [h.Id('s-voice'), h.OnChange((value) => Message.UpdatedDraft({ draft: { ...draft, voice: value } }))],
      [
        h.option([h.Value(''), h.Selected(draft.voice === '')], ['auto — varies per aircraft']),
        ...model.browserVoices.map((v) => h.option([h.Value(v.name), h.Selected(draft.voice === v.name)], [`${v.name} (${v.lang})`])),
      ],
    )
  }
  const voices = model.models?.speech[draft.ttsModel.trim()] ?? null
  const shown = voices === null ? [] : professionalVoices(voices)
  const hidden = voices === null ? 0 : voices.length - shown.length
  return h.select(
    [h.Id('s-voice'), h.OnChange((value) => Message.UpdatedDraft({ draft: { ...draft, ttsVoice: value } }))],
    model.models === null
      ? [h.option([h.Value('')], ['load the model list for voices'])]
      : voices === null || voices.length === 0
        ? [h.option([h.Value('')], ['provider default (this model lists no voices)'])]
        : [
            h.option([h.Value(''), h.Selected(draft.ttsVoice === '')], ['auto — varies per aircraft']),
            ...shown.map((v) => h.option([h.Value(v), h.Selected(draft.ttsVoice === v)], [v])),
            ...(hidden > 0 ? [h.option([h.Value(''), h.Disabled(true)], [`— ${hidden} stylised voices hidden —`])] : []),
          ],
  )
}

const checkbox = (h: HtmlBuilder<Message>, model: Model, id: string, key: 'tts' | 'radio' | 'autoTrack', note: string): Html =>
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
      h.h3([], ['Plain-English commands · OpenRouter key']),
      h.p([], [
        'Anything that isn\'t a recognised command is sent to the model below, which translates what you\'d say on frequency into ATCTrainer commands. The app ships with a shared, rate-limited ',
        h.a([h.Href('https://openrouter.ai/keys'), h.Target('_blank'), h.Rel('noopener')], ['OpenRouter']),
        ' key; paste your own to use your account (clearing the field goes back to the shared one). The key is stored only in this browser\'s local storage and sent only to openrouter.ai.',
      ]),
      h.div([h.Class('field')], [
        ...field(h, 's-key', 'OpenRouter API key', textInput(h, model, 's-key', 'key', 'sk-or-v1-…', 'password')),
        ...field(h, 's-model', 'Model', h.div([h.Class('row')], [textInput(h, model, 's-model', 'model', 'anthropic/claude-haiku-4.5', 'text', 'models'), h.button([h.Class('tbtn'), h.Type('button'), h.OnClick(Message.ClickedLoadModels())], ['Load list'])]),
          model.models === null
            ? 'Any OpenRouter model id. Fast, cheap models do this job well — the prompt is small and the reply is a few lines of JSON.'
            : `${model.models.ids.length} models available on OpenRouter (${model.models.audioIds.length} accept audio) — start typing in a Model box to filter.`),
      ]),
      datalist(h, 'models', model.models?.ids ?? []),
      datalist(h, 'audiomodels', model.models?.audioIds ?? []),
      datalist(h, 'ttsmodels', Object.keys(model.models?.speech ?? {}).sort()),
      h.h3([], ['Audio · push-to-talk and pilot voices']),
      h.p([], [
        'Hold the ', h.b([], ['PTT']), ' button (or hold ', h.b([], ['Space']), ' while the command box isn\'t focused), say the transmission, release. With an OpenRouter key, the recording goes to an audio-capable model that transcribes it and translates it into commands in one step. Without a key, the browser\'s own speech recognition is used where available and the words are treated as typed. Pilots read back through an OpenRouter speech model by default; the browser\'s own speech synthesis is the offline fallback. The frequency is half-duplex: no pilot starts talking while you hold the mic — a call that comes up under it is logged at once and spoken when you release.',
      ]),
      h.div([h.Class('field')], [
        ...field(h, 's-audio', 'Audio model', textInput(h, model, 's-audio', 'audioModel', 'google/gemini-3.5-flash-lite', 'text', 'audiomodels'), 'Must accept audio input — Load list above fills this picker with only those models. Gemini Flash models are fast and cheap for this.'),
        ...field(h, 's-tts', 'Speak pilot transmissions', checkbox(h, model, 's-tts', 'tts', 'readbacks, hold-shorts, ready calls')),
        ...field(h, 's-engine', 'Voice engine', h.select(
          [h.Id('s-engine'), h.OnChange((v) => Message.UpdatedDraft({ draft: { ...model.draft, ttsEngine: v === 'openrouter' ? 'openrouter' : 'browser' } }))],
          [
            h.option([h.Value('browser'), h.Selected(model.draft.ttsEngine === 'browser')], ['Browser speech synthesis (free, offline)']),
            h.option([h.Value('openrouter'), h.Selected(model.draft.ttsEngine === 'openrouter')], ['OpenRouter text-to-speech (uses your key)']),
          ],
        )),
        ...field(h, 's-ttsmodel', 'TTS model', textInput(h, model, 's-ttsmodel', 'ttsModel', 'hexgrad/kokoro-82m', 'text', 'ttsmodels'), 'Any OpenRouter speech model. Kokoro is a fraction of a cent per call with many English voices; Deepgram Aura-2, Gemini TTS and MiniMax sound richer and cost more. Priced per character.'),
        ...field(h, 's-voice', 'Pilot voice', voiceSelect(h, model)),
        ...field(h, 's-radio', 'Radio effect', checkbox(h, model, 's-radio', 'radio', 'band-limit OpenRouter voices like a VHF receiver')),
      ]),
      h.h3([], ['Radar']),
      h.div([h.Class('field')], [
        ...field(h, 's-autotrack', 'Auto-track', checkbox(h, model, 's-autotrack', 'autoTrack', 'start a track on every target as radar acquires it; DROP still drops one, and with this off TRACK starts them')),
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
      h.h3([], ['Shared sessions']),
      h.p([], [
        'Sessions connect browsers directly. Most home networks connect on their own; when two peers cannot (symmetric or carrier-grade NAT), a TURN relay carries the traffic. Any TURN provider works; leave empty until you need it.',
      ]),
      h.div([h.Class('field')], [
        ...field(h, 's-turn', 'TURN server', textInput(h, model, 's-turn', 'turnUrl', 'turn:relay.example.com:3478'), 'A turn: or turns: URL.'),
        ...field(h, 's-turn-user', 'TURN username', textInput(h, model, 's-turn-user', 'turnUsername', '')),
        ...field(h, 's-turn-cred', 'TURN credential', textInput(h, model, 's-turn-cred', 'turnCredential', '', 'password')),
      ]),
    ],
    [
      h.span([h.Class(`status ${model.settingsStatus.kind}`)], [model.settingsStatus.text]),
      h.button([h.Class('tbtn'), h.Type('button'), h.OnClick(Message.ClickedTestKey())], ['Test key']),
      h.button([h.Class('tbtn'), h.Type('button'), h.OnClick(Message.ClickedTestVoice())], ['Test voice']),
      h.button([h.Class('tbtn'), h.Type('button'), h.AriaPressed('true'), h.OnClick(Message.ClickedSaveSettings())], ['Save']),
    ],
    h,
  )

export const sessionLink = (room: string): string =>
  `${globalThis.location?.origin ?? ''}${globalThis.location?.pathname ?? '/'}#join/${room}`

export const sessionView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const session = model.session
  const solo = session.role === 'solo'
  return shell(
    'Shared session',
    [
      h.p([], [
        'Anyone can watch this session live and give instructions, an instructor for example. One browser ',
        h.b([], ['hosts']), ': it keeps the clock and the authoritative airport, and everyone else follows it with the same controls. Connections are direct between browsers with no server in between; if two networks cannot connect, add a TURN relay in Settings.',
      ]),
      ...(solo
        ? [
            h.h3([], ['Host']),
            h.div([h.Class('field')], [
              h.label([], ['Start a session here']),
              h.div([h.Class('row')], [h.button([h.Class('tbtn'), h.Type('button'), h.OnClick(Message.ClickedHostSession())], ['Host a session'])]),
              h.small([], ['You get a six-character code and a link to share.']),
            ]),
            h.h3([], ['Join']),
            h.div([h.Class('field')], [
              h.label([h.For('s-room')], ['Room code']),
              h.div([h.Class('row')], [
                h.input([h.Id('s-room'), h.Type('text'), h.Autocomplete('off'), h.Placeholder('ABC123'), h.Value(session.roomInput), h.OnInput((value) => Message.UpdatedRoomInput({ value }))]),
                h.button([h.Class('tbtn'), h.Type('button'), h.OnClick(Message.ClickedJoinSession())], ['Join']),
              ]),
              h.small([], ['Joining replaces what you see with the host\'s session; leaving keeps a copy running solo.']),
            ]),
          ]
        : [
            h.h3([], [session.role === 'host' ? 'Hosting' : 'Joined']),
            h.div([h.Class('field')], [
              h.label([], ['Room code']),
              h.div([h.Class('row')], [h.b([h.Class('room-code')], [session.room ?? ''])]),
              h.label([], ['Link']),
              h.div([h.Class('row')], [h.input([h.Type('text'), h.Readonly(true), h.Value(sessionLink(session.room ?? ''))])]),
              h.label([], ['Peers']),
              h.div([h.Class('row')], [session.peers.length === 0 ? 'waiting for peers…' : session.peers.map((p) => p.slice(0, 6)).join(', ')]),
              h.label([], ['Status']),
              h.div([h.Class('row')], [session.status === 'connecting' ? 'connecting…' : session.status]),
            ]),
          ]),
      session.error === null ? h.empty : h.p([h.Class('bad')], [session.error]),
    ],
    solo ? [] : [h.button([h.Class('tbtn'), h.Type('button'), h.OnClick(Message.ClickedLeaveSession())], ['Leave session'])],
    h,
  )
}
