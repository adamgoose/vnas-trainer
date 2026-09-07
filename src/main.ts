import { Layer } from 'effect'
import { Runtime } from 'foldkit'

import { Message } from './app/message'
import { Model } from './app/model'
import { subscriptions } from './app/subscriptions'
import { init, update } from './app/update'
import { HttpTextLive } from './services/http'
import { MicrophoneBrowser } from './services/microphone'
import { OpenRouterLive } from './services/openRouter'
import { RecognitionBrowser } from './services/recognition'
import { SessionTrystero } from './services/session'
import { SettingsStoreBrowser } from './services/settings'
import { SpeechBrowser } from './services/speech'
import { VideoMapsLive } from './services/videoMaps'
import { VnasDataLive } from './services/vnasData'
import { view } from './view/page'

const resources = Layer.mergeAll(
  Layer.mergeAll(VnasDataLive, VideoMapsLive).pipe(Layer.provide(HttpTextLive)),
  SettingsStoreBrowser,
  OpenRouterLive,
  SpeechBrowser.pipe(Layer.provide(OpenRouterLive)),
  MicrophoneBrowser,
  RecognitionBrowser,
  SessionTrystero,
)

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  resources,
  container: document.getElementById('root'),
  devTools: {
    Message,
    mode: 'TimeTravel',
    maxEntries: 500,
    excludeFromHistory: ['Ticked', 'MovedScope', 'WheeledScope', 'PressedScope', 'ReleasedScope', 'ScrubbedTimeline'],
  },
})

Runtime.run(application)
