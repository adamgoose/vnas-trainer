/** Decodes every file in catalog/ through the schemas; reports the first error per file. */
import { readdirSync, readFileSync } from 'node:fs'

import { decodeAirportFile, decodeCatalogIndex } from '../src/domain/catalog'

const root = new URL('../catalog/', import.meta.url)
const failures: Array<string> = []
try {
  decodeCatalogIndex(JSON.parse(readFileSync(new URL('index.json', root), 'utf8')))
} catch (e) {
  failures.push(`index.json: ${String(e).split('\n').slice(0, 3).join(' ')}`)
}
const files = readdirSync(new URL('airports/', root)).filter((f) => f.endsWith('.json'))
for (const f of files) {
  try {
    decodeAirportFile(JSON.parse(readFileSync(new URL(`airports/${f}`, root), 'utf8')))
  } catch (e) {
    failures.push(`${f}: ${String(e).split('\n').slice(0, 3).join(' ')}`)
  }
}
console.log(`${files.length - failures.length}/${files.length} airport files decode`)
failures.forEach((f) => console.log('  ' + f))
process.exit(failures.length === 0 ? 0 : 1)
