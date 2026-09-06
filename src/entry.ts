import { Layer } from 'effect'
import { Runtime } from 'foldkit'

import { Message, Model, init, subscriptions, update, view } from './app/main'
import { HttpTextLive } from './services/http'
import { VnasDataCatalog } from './services/vnasData'

const resources = VnasDataCatalog().pipe(Layer.provide(HttpTextLive))

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
