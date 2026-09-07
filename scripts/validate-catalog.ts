/** Decodes every file in catalog/ through the schemas; reports the first error per file. */
import { readdirSync, readFileSync } from 'node:fs'

import { decodeAirportFile, decodeArtccFile, decodeCatalogIndex } from '../src/domain/catalog'

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
const artccFiles = ((): Array<string> => {
  try {
    return readdirSync(new URL('artccs/', root)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
})()
for (const f of artccFiles) {
  try {
    decodeArtccFile(JSON.parse(readFileSync(new URL(`artccs/${f}`, root), 'utf8')))
  } catch (e) {
    failures.push(`artccs/${f}: ${String(e).split('\n').slice(0, 3).join(' ')}`)
  }
}
console.log(`${files.length + artccFiles.length - failures.length}/${files.length + artccFiles.length} files decode (${files.length} airports, ${artccFiles.length} ARTCCs)`)
failures.forEach((f) => console.log('  ' + f))
process.exit(failures.length === 0 ? 0 : 1)
