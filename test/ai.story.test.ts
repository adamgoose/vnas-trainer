import { describe, expect, test } from 'bun:test'
import { Command, given, message, model, story } from 'foldkit/story'

import { LoadModels, SaveSettings, Speak, StartRecognition, StartRecording, StopRecognition, StopRecording, StopSpeaking, TestKey, TestVoice, TranslateAudio, TranslateText } from '../src/app/commands'
import { Message } from '../src/app/message'
import { type Model, initialModel, worldOf } from '../src/app/model'
import { applyEvents, update, utteranceFor } from '../src/app/update'
import { phrase, runway, callsign } from '../src/domain/phrase'
import { SimEvent } from '../src/domain/world'
import { defaultSettings } from '../src/services/settings'
import { msp } from './helpers'

const surfaceCount = (s: (typeof msp.scen)[number]) => s.ac.filter((a) => a.k !== 'A').length
const big = msp.scen.reduce((best, s) => (surfaceCount(s) > surfaceCount(best) ? s : best), msp.scen[0]!)
const keyed = { ...defaultSettings, ttsEngine: 'browser' as const, key: 'sk-test', model: 'test/model', audioModel: 'test/audio' }
/** the shipped key is on by default; these stories want plain-English commands off */
const keyless = { ...defaultSettings, ttsEngine: 'browser' as const, key: '' }

const ready = (settings = defaultSettings): Model => {
  let m = update(initialModel, Message.CompletedLoadSettings({ settings })).model
  m = update(m, Message.CompletedReadDeepLink({ airport: 'MSP', scenario: big.id, room: null })).model
  m = update(m, Message.ResizedScope({ width: 1000, height: 700, devicePixelRatio: 1 })).model
  m = update(m, Message.CompletedLoadIndex({ index: { built: '', artccs: [{ id: 'ZMP', name: 'Minneapolis ARTCC', airports: [{ id: 'MSP', name: 'Minneapolis ATCT', n: 64, asdex: true, gates: 220, taxi: 106, stars: true }] }] } })).model
  m = update(m, Message.CompletedLoadAirport({ airport: msp })).model
  m = update(m, Message.CompletedLoadScenario({ airportId: 'MSP', scenario: big })).model
  return m
}

describe('pilot voices', () => {
  test('a pilot line becomes a Speak command with the callsign appended, unless the phrase carries it', () => {
    expect(utteranceFor('DAL1047', phrase('holding short of', runway('30L')))).toBe('holding short of three zero left, Delta ten forty-seven')
    expect(utteranceFor('DAL1047', phrase('Minneapolis Tower,', callsign('DAL1047'), ', six mile final'))).toBe('Minneapolis Tower, Delta ten forty-seven, six mile final')
    const m = ready()
    const out = applyEvents(m, [SimEvent.PilotSaid({ callsign: 'AAL894', phrase: phrase('ready to taxi') })])
    expect(out.model.log[0]).toMatchObject({ kind: 'pilot', who: 'AAL894', text: 'ready to taxi' })
    expect(out.commands.map((c) => [c.name, (c.args as { text: string }).text])).toEqual([[Speak.name, 'ready to taxi, American eight ninety-four']])
    const muted = applyEvents({ ...m, settings: { ...m.settings, tts: false } }, [SimEvent.PilotSaid({ callsign: 'AAL894', phrase: phrase('ready to taxi') })])
    expect(muted.commands).toEqual([])
    const quiet = applyEvents(m, [SimEvent.PilotSaid({ callsign: 'AAL894', phrase: phrase('ready to taxi') }), SimEvent.SystemNote({ text: 'note' })], { quiet: true })
    expect(quiet.model.log[0]?.text).toBe('note')
    expect(quiet.model.log.some((l) => l.text === 'ready to taxi')).toBe(false)
    expect(quiet.commands).toEqual([])
  })

  test('turning the speaker off stops speech', () => {
    story(
      update,
      given(ready()),
      message(Message.ClickedSpeaker()),
      Command.expectHas(StopSpeaking),
      Command.resolve(StopSpeaking, Message.CompletedStopSpeaking()),
      Command.resolve(SaveSettings, Message.CompletedSaveSettings()),
      model((m) => expect(m.settings.tts).toBe(false)),
    )
  })
})

describe('plain English', () => {
  test('without a key, unknown text is refused; with a key it goes to the model', () => {
    story(
      update,
      given(ready(keyless)),
      message(Message.UpdatedCommandText({ value: 'American 894 push back approved' })),
      message(Message.SubmittedCommand()),
      Command.expectNone(),
      model((m) => expect(m.log[0]?.text).toMatch(/^unrecognised command/)),
    )
    story(
      update,
      given(ready(keyed)),
      message(Message.UpdatedCommandText({ value: 'American 894 push back approved' })),
      message(Message.SubmittedCommand()),
      Command.expectExact(TranslateText),
      model((m) => expect(m.pendingAi).toBe('translating…')),
      Command.resolve(
        TranslateText,
        Message.CompletedTranslate({
          translation: { transcript: null, callsign: 'AAL894', commands: ['PUSH', 'SQ 4521'], readback: 'Push approved, squawk 4521, American 894', spoken: 'Push approved, squawk four five two one, American eight ninety-four' },
          said: 'American 894 push back approved',
        }),
      ),
      Command.expectExact(Speak({ callsign: 'AAL894', text: 'Push approved, squawk four five two one, American eight ninety-four', engine: 'browser', key: 'sk-test', model: defaultSettings.ttsModel, providerVoice: '', browserVoice: '', radio: true })),
      Command.resolve(Speak, Message.CompletedSpeak()),
      model((m) => {
        expect(m.pendingAi).toBeNull()
        expect(m.selected).toBe('AAL894')
        const a = worldOf(m)!.aircraft.find((x) => x.callsign === 'AAL894')!
        expect(a.state).toBe('PUSH')
        expect(a.squawk).toBe('4521')
        expect(m.log.map((l) => `${l.kind}:${l.text}`).slice(0, 2)).toEqual(['pilot:Push approved, squawk 4521, American 894', 'atc:American 894 push back approved'])
        expect(m.commandLog).toHaveLength(2)
      }),
    )
  })

  test('a failed command in a translation suppresses the readback; an unknown callsign is reported', () => {
    story(
      update,
      given(ready(keyed)),
      message(Message.CompletedTranslate({ translation: { transcript: null, callsign: 'AAL894', commands: ['CTO'], readback: 'Cleared for takeoff', spoken: null }, said: 'cleared for takeoff' })),
      Command.expectNone(),
      model((m) => {
        expect(m.log[0]).toMatchObject({ kind: 'err', text: 'unable — no departure runway assigned' })
        expect(m.log.some((l) => l.text === 'Cleared for takeoff')).toBe(false)
      }),
      message(Message.CompletedTranslate({ translation: { transcript: null, callsign: 'ZZZ1', commands: [], readback: 'say again', spoken: null }, said: 'mumble' })),
      model((m) => expect(m.log[0]?.text).toBe('no aircraft matched "ZZZ1" — say again')),
      message(Message.FailedTranslate({ error: 'HTTP 401', audio: false })),
      model((m) => expect(m.log[0]?.text).toBe('could not translate that (HTTP 401) — try the command syntax')),
    )
  })

  test('a spoken readback without a spoken form gets the best-effort spoken text', () => {
    story(
      update,
      given(ready(keyed)),
      message(Message.CompletedTranslate({ translation: { transcript: null, callsign: null, commands: [], readback: 'Roger, DAL1047', spoken: null }, said: 'hi' })),
      Command.expectNone(),
      model((m) => expect(m.log[0]?.text).toBe('no aircraft matched "—" — Roger, DAL1047')),
    )
    story(
      update,
      given({ ...ready(keyed), selected: 'AAL894' }),
      message(Message.CompletedTranslate({ translation: { transcript: null, callsign: null, commands: [], readback: 'Roger, AAL894', spoken: null }, said: 'hi' })),
      Command.expectExact(Speak({ callsign: 'AAL894', text: 'Roger, American eight ninety-four', engine: 'browser', key: 'sk-test', model: defaultSettings.ttsModel, providerVoice: '', browserVoice: '', radio: true })),
      Command.resolve(Speak, Message.CompletedSpeak()),
    )
  })
})

describe('push-to-talk', () => {
  test('with a key: record, stop, transcribe, apply', () => {
    story(
      update,
      given(ready(keyed)),
      message(Message.PressedPtt()),
      Command.expectExact(StartRecording),
      model((m) => expect(m.ptt).toBe('tx')),
      Command.resolve(StartRecording, Message.CompletedStartRecording()),
      message(Message.PressedPtt()),
      Command.expectNone(),
      message(Message.ReleasedPtt()),
      Command.expectExact(StopRecording),
      Command.resolve(StopRecording, Message.CompletedStopRecording({ wavBase64: 'UklGRg==', seconds: 1.5 })),
      Command.expectExact(TranslateAudio),
      model((m) => {
        expect(m.ptt).toBe('busy')
        expect(m.pendingAi).toBe('transcribing 1.5s…')
      }),
      Command.resolve(
        TranslateAudio,
        Message.CompletedTranslate({ translation: { transcript: 'AAL894 hold position', callsign: 'AAL894', commands: ['HOLD'], readback: 'Holding, American 894', spoken: 'Holding, American eight ninety-four' }, said: 'AAL894 hold position' }),
      ),
      Command.resolve(Speak, Message.CompletedSpeak()),
      model((m) => {
        expect(m.ptt).toBe('idle')
        expect(m.log[1]?.text).toBe('AAL894 hold position')
        expect(worldOf(m)!.aircraft.find((a) => a.callsign === 'AAL894')!.state).toBe('HOLD')
      }),
      message(Message.PressedPtt()),
      Command.resolve(StartRecording, Message.CompletedStartRecording()),
      message(Message.ReleasedPtt()),
      Command.resolve(StopRecording, Message.CompletedStopRecording({ wavBase64: null, seconds: 0.2 })),
      Command.expectNone(),
      model((m) => {
        expect(m.ptt).toBe('idle')
        expect(m.log[0]?.text).toBe('transmission too short')
      }),
    )
  })

  test('without a key: browser recognition when available, otherwise a hint', () => {
    story(
      update,
      given({ ...ready(keyless), recognitionAvailable: false }),
      message(Message.PressedPtt()),
      Command.expectNone(),
      model((m) => expect(m.log[0]?.text).toMatch(/^no speech recognition/)),
    )
    story(
      update,
      given({ ...ready(keyless), recognitionAvailable: true }),
      message(Message.PressedPtt()),
      Command.expectExact(StartRecognition),
      Command.resolve(StartRecognition, Message.CompletedStartRecognition()),
      model((m) => expect(m.ptt).toBe('listen')),
      message(Message.HeardRecognition({ text: 'AAL894 PUSH' })),
      Command.resolve(Speak, Message.CompletedSpeak()),
      model((m) => expect(worldOf(m)!.aircraft.find((a) => a.callsign === 'AAL894')!.state).toBe('PUSH')),
      message(Message.ReleasedPtt()),
      Command.expectExact(StopRecognition),
      Command.resolve(StopRecognition, Message.CompletedStopRecognition()),
      model((m) => expect(m.ptt).toBe('idle')),
    )
  })
})

describe('settings actions', () => {
  test('Load list, Test key and Test voice report through the status line', () => {
    story(
      update,
      given({ ...ready(), draft: { ...defaultSettings, key: ' sk-or-1 ', model: 'm' } }),
      message(Message.ClickedLoadModels()),
      Command.expectExact(LoadModels({ key: 'sk-or-1' })),
      Command.resolve(LoadModels, Message.CompletedLoadModels({ models: { ids: ['a', 'b'], audioIds: ['a'], speech: { 'k/kokoro': ['af_heart', 'af_heart_whisper'] } } })),
      model((m) => expect(m.settingsStatus).toEqual({ text: '2 models loaded, 1 with audio input, 1 speech models', kind: 'ok' })),
      message(Message.ClickedTestKey()),
      Command.expectExact(TestKey({ key: 'sk-or-1', model: 'm' })),
      Command.resolve(TestKey, Message.CompletedTestKey({ ok: true, detail: 'works — m answered' })),
      model((m) => expect(m.settingsStatus.kind).toBe('ok')),
      message(Message.ClickedTestVoice()),
      Command.expectExact(TestVoice),
      Command.resolve(TestVoice, Message.CompletedTestVoice({ ok: true, detail: 'playing browser voice' })),
      model((m) => expect(m.settingsStatus.text).toBe('playing browser voice')),
      message(Message.UpdatedDraft({ draft: { ...defaultSettings, ttsEngine: 'openrouter', key: '' } })),
      message(Message.ClickedTestVoice()),
      Command.expectNone(),
      model((m) => expect(m.settingsStatus).toEqual({ text: 'OpenRouter voices need an API key', kind: 'bad' })),
      message(Message.UpdatedDraft({ draft: { ...defaultSettings, ttsEngine: 'openrouter', key: 'https://openrouter.ai/keys' } })),
      message(Message.ClickedTestVoice()),
      Command.expectNone(),
      model((m) => expect(m.settingsStatus.text).toMatch(/doesn't look like an OpenRouter key/)),
      message(Message.ClickedTestKey()),
      Command.expectNone(),
      model((m) => expect(m.settingsStatus.kind).toBe('bad')),
      message(Message.UpdatedDraft({ draft: { ...defaultSettings, ttsEngine: 'openrouter', key: 'sk-or-v1-abc' } })),
      message(Message.ClickedTestVoice()),
      Command.expectExact(TestVoice),
      Command.resolve(TestVoice, Message.CompletedTestVoice({ ok: false, detail: 'speech failed: HTTP 503' })),
      model((m) => expect(m.settingsStatus).toEqual({ text: 'speech failed: HTTP 503', kind: 'bad' })),
    )
  })
})
