#!/usr/bin/env node
/**
 * Builds catalog/ from the vNAS data API.
 *
 * Why a build step: vNAS serves /api/* without an Access-Control-Allow-Origin
 * header, so a page on your own domain cannot read training airports or
 * scenarios directly. This script runs in Node, where CORS does not apply, and
 * bakes everything the page needs into static JSON. Video map geometry under
 * /Files/* does send CORS headers, so ASDE-X pavement is still fetched live.
 *
 *   node build-catalog.mjs              # every ARTCC
 *   node build-catalog.mjs ZMP ZLA      # just these
 *
 * Output:
 *   catalog/index.json          ARTCC -> airports (name, scenario count)
 *   catalog/airports/{APT}.json map, fleet, ASDE-X map id, compact scenarios
 *
 * Node 18+, no dependencies.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { API, compactMap, compactScenario, facilityIndex, parseLenientJSON, scenarioForAirport, starsForAirport } from './lib/vnas.mjs';

const OUT = new URL('./catalog/', import.meta.url);
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase());
const CONCURRENCY = +(process.env.CONCURRENCY || 8);

async function get(path, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return parseLenientJSON(await r.text());
    } catch (e) {
      if (i >= tries) throw new Error(`${path}: ${e.message}`);
      await new Promise((res) => setTimeout(res, 800 * i));
    }
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

await mkdir(new URL('airports/', OUT), { recursive: true });

const [artccSummaries, airportSummaries, scenarioSummaries] = await Promise.all([
  get('/artcc-summaries'), get('/training/airport-summaries'), get('/training/scenario-summaries'),
]);
const artccName = Object.fromEntries(artccSummaries.map((s) => [s.id, s.name]));

let airports = airportSummaries;
if (wanted.length) airports = airports.filter((a) => wanted.includes(a.artccId));
const artccIds = [...new Set(airports.map((a) => a.artccId))].sort();
console.log(`${airports.length} training airports across ${artccIds.length} ARTCC(s)`);

// ---- ARTCC facility trees: names, tower locations, ASDE-X video map ids, position callsigns
const facIndex = {};
await pool(artccIds, 4, async (id) => {
  const doc = await get(`/artccs/${id}`);
  facIndex[id] = doc ? facilityIndex(doc) : { facilities: {}, positions: {}, videoMaps: {} };
  console.log(`  ${id}: ${Object.keys(facIndex[id].facilities).length} facilities`);
});

// ---- every scenario for the ARTCCs in scope, compacted
const scenList = scenarioSummaries.filter((s) => artccIds.includes(s.artccId));
console.log(`fetching ${scenList.length} scenarios…`);
let done = 0;
const compact = await pool(scenList, CONCURRENCY, async (s) => {
  const doc = await get(`/training/scenarios/${s.id}`);
  if (++done % 200 === 0) console.log(`  ${done}/${scenList.length}`);
  if (!doc) return null;
  return compactScenario(doc, facIndex[s.artccId]?.positions || {});
});

// ---- per-airport files
const index = {};
await pool(airports, CONCURRENCY, async (a) => {
  let apt, mapDoc;
  try {
    [apt, mapDoc] = await Promise.all([
      get(`/training/airports/${a.id}`), get(`/training/airports/${a.id}/map`),
    ]);
  } catch (e) { console.log(`  ${a.id}: ${e.message} — skipped`); return; }
  if (!mapDoc) { console.log(`  ${a.id}: no map, skipped`); return; }
  const map = compactMap(mapDoc);
  if (!map.rwy.length) { console.log(`  ${a.id}: map has no runways, skipped`); return; }
  const fac = facIndex[a.artccId]?.facilities?.[a.id] || {};
  const scen = compact
    .map((c) => c && scenarioForAirport(c, a.id))
    .filter(Boolean)
    .sort((x, y) => x.name.localeCompare(y.name));
  const doc = {
    id: a.id,
    artcc: a.artccId,
    name: fac.name || a.id,
    tower: fac.tower || null,
    asdex: fac.asdex || null,
    twrmap: fac.twrmap || null,
    updated: a.lastUpdatedAt || null,
    init: { jet: apt?.jetInitialAltitude || null, prop: apt?.propInitialAltitude || null, pattern: apt?.patternAltitude || null },
    stars: facIndex[a.artccId] ? starsForAirport(facIndex[a.artccId], a.id) : null,
    fleet: (apt?.trainingAircraftSets || []).map((s) => ({ a: s.airlineIcaoCode, w: s.weight || 1, t: s.aircraftTypeCodes || [] })),
    map,
    scen,
  };
  await writeFile(new URL(`airports/${a.id}.json`, OUT), JSON.stringify(doc));
  (index[a.artccId] ||= []).push({ id: a.id, name: doc.name, n: scen.length, asdex: !!doc.asdex,
    gates: Object.keys(map.park).length, taxi: map.taxi.length, stars: !!doc.stars });
  console.log(`  ${a.id.padEnd(4)} ${doc.name.padEnd(34)} ${String(scen.length).padStart(3)} scenarios  ` +
    `${String(map.taxi.length).padStart(3)} taxiways  ${String(Object.keys(map.park).length).padStart(3)} gates${doc.asdex ? '  ASDE-X' : ''}` +
    `${doc.stars ? `  STARS ${doc.stars.host} ${doc.stars.def.length} maps${doc.stars.dep ? ' dep ' + doc.stars.dep.freq : ''}` : ''}`);
});

const artccs = Object.keys(index).sort().map((id) => ({
  id, name: artccName[id] || id, airports: index[id].sort((a, b) => a.id.localeCompare(b.id)),
}));
await writeFile(new URL('index.json', OUT), JSON.stringify({ built: new Date().toISOString(), artccs }));
console.log(`\nWrote catalog/index.json + ${artccs.reduce((n, a) => n + a.airports.length, 0)} airport files.`);
