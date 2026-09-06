import { readFileSync } from 'node:fs'

import { type AirportFile, decodeAirportFile } from '../src/domain/catalog'

export const loadMsp = (): AirportFile =>
  decodeAirportFile(JSON.parse(readFileSync(new URL('./fixtures/MSP.json', import.meta.url), 'utf8')))
