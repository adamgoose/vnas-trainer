import { Layer } from 'effect'
import { Runtime } from 'foldkit'

import { Message } from './app/message'
import { Model } from './app/model'
import { subscriptions } from './app/subscriptions'
import { init, update } from './app/update'
import { HttpTextLive } from './services/http'
import { SettingsStoreBrowser } from './services/settings'
import { VideoMapsLive } from './services/videoMaps'
import { VnasDataLive } from './services/vnasData'
import { view } from './view/page'

const resources = Layer.mergeAll(VnasDataLive, VideoMapsLive).pipe(Layer.provide(HttpTextLive), Layer.merge(SettingsStoreBrowser))

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
    excludeFromHistory: ['Ticked'],
  },
})

Runtime.run(application)
