/**
 * Shared helpers for turning vNAS training data into the compact shapes the
 * trainer consumes. Used by build-catalog.mjs (Node) and app.js (browser).
 *
 * vNAS endpoints involved (all under data-api.vnas.vatsim.net):
 *   /api/artcc-summaries                     ARTCC ids + names
 *   /api/artccs/{ARTCC}                      facility tree, positions, ASDE-X map ids
 *   /api/training/airport-summaries          every training airport + its ARTCC
 *   /api/training/airports/{APT}             fleet sets, pattern data
 *   /api/training/airports/{APT}/map         GeoJSON: taxiway centrelines, runways, parking
 *   /api/training/scenario-summaries         every scenario id/name/airport
 *   /api/training/scenarios/{ID}             full scenario
 *   /Files/VideoMaps/{ARTCC}/{ID}.geojson    video map geometry (sends CORS headers)
 */

export const API = 'https://data-api.vnas.vatsim.net/api';
export const FILES = 'https://data-api.vnas.vatsim.net/Files';

/**
 * Airport maps are hand-edited GeoJSON and a few are not strictly valid JSON:
 * `//` comment lines, trailing commas, and headings written as `010`.
 * Try the strict parse first, then repair those three things and retry.
 */
export function parseLenientJSON(text) {
  try { return JSON.parse(text); } catch { /* repair below */ }
  const fixed = text
    .replace(/^\s*\/\/.*$/gm, '')                       // comment lines
    .replace(/([:\[,]\s*-?)0+(\d)/g, '$1$2')             // leading zeros: 010 -> 10
    .replace(/,\s*([\]}])/g, '$1');                      // trailing commas
  return JSON.parse(fixed);
}

const r6 = (n) => Math.round(n * 1e6) / 1e6;
const pt = (c) => [r6(c[0]), r6(c[1])];

/** "H/B744/L" -> "B744", "B738/L" -> "B738" */
export function aircraftType(s) {
  const parts = String(s || '').split('/').filter(Boolean);
  if (!parts.length) return '';
  if (parts[0].length <= 1 && parts.length > 1) return parts[1];
  return parts[0];
}

/** Training-map GeoJSON -> compact map used by the graph builder. */
export function compactMap(geojson) {
  const out = { taxi: [], rwy: [], park: {}, spot: {} };
  for (const f of geojson?.features ?? []) {
    const p = f.properties || {};
    const g = f.geometry || {};
    const t = String(p.type || '').toLowerCase();
    const name = String(p.name || '').trim();
    if (!name) continue;
    if (t === 'taxiway' && g.type === 'LineString') {
      out.taxi.push({ n: name.toUpperCase(), c: g.coordinates.map(pt) });
    } else if (t === 'runway' && g.type === 'LineString') {
      out.rwy.push({
        n: name.toUpperCase().replace(/\s+/g, ''),
        c: g.coordinates.map(pt),
        thr: p.threshold ?? null,
        to: p.turnoff ?? null,
      });
    } else if ((t === 'parking' || t === 'spot') && g.type === 'Point') {
      let h = parseFloat(p.heading);
      if (!Number.isFinite(h)) h = 0;
      const rec = [r6(g.coordinates[0]), r6(g.coordinates[1]), Math.round(h)];
      (t === 'parking' ? out.park : out.spot)[name.toUpperCase()] = rec;
    }
  }
  return out;
}

/**
 * ARTCC document -> { facilities: {id -> {name,type,tower,asdex,twrmap}},
 *                     positions: {positionId -> callsign} }
 */
export function facilityIndex(artcc) {
  const facilities = {};
  const positions = {};
  const walk = (f) => {
    if (!f) return;
    const loc = f.towerCabConfiguration?.towerLocation;
    facilities[f.id] = {
      name: f.name || f.id,
      type: f.type || null,
      tower: loc ? [r6(loc.lon), r6(loc.lat)] : null,
      asdex: f.asdexConfiguration?.videoMapId || null,
      twrmap: f.towerCabConfiguration?.videoMapId || null,
    };
    for (const p of f.positions || []) positions[p.id] = p.callsign || p.name || p.id;
    for (const c of f.childFacilities || []) walk(c);
  };
  walk(artcc?.facility);
  return { facilities, positions };
}

/**
 * Full scenario -> compact record with the surface aircraft grouped by airport.
 *   { id, name, stu, n, air, gen, byAirport: { APT: [ {cs,ty,k,at,h?,d,dep,dst,r,q?,nm?} ] } }
 * k: P = parked at a gate, R = holding on/at a runway, F = on final.
 * Airborne aircraft (Coordinates / FixOrFrd starts) are counted in `air` only.
 */
export function compactScenario(scn, positions = {}) {
  const byAirport = {};
  const queue = {};
  let air = 0;
  for (const a of scn.aircraft || []) {
    const sc = a.startingConditions || {};
    const apt = String(a.airportId || scn.primaryAirportId || '').toUpperCase();
    const fp = a.flightplan || {};
    const base = {
      cs: a.aircraftId,
      ty: aircraftType(a.aircraftType || fp.aircraftType),
      d: a.spawnDelay || 0,
      dep: fp.departure || null,
      dst: fp.destination || null,
      r: (fp.rules || 'I')[0],
    };
    let rec = null;
    if (sc.type === 'Parking') {
      rec = { ...base, k: 'P', at: String(sc.parking || '').toUpperCase() };
    } else if (sc.type === 'OnRunway') {
      const rw = String(sc.runway || '').toUpperCase();
      const key = apt + '/' + rw;
      const q = queue[key] || 0;
      queue[key] = q + 1;
      rec = { ...base, k: 'R', at: rw, q };
    } else if (sc.type === 'OnFinal') {
      rec = { ...base, k: 'F', at: String(sc.runway || '').toUpperCase(), nm: sc.distanceFromRunway || 5 };
    } else {
      air++;
      continue;
    }
    if (!apt) continue;
    (byAirport[apt] ||= []).push(rec);
  }
  const gen = [...new Set((scn.aircraftGenerators || []).map((g) => String(g.runway || '').toUpperCase()).filter(Boolean))];
  return {
    id: scn.id,
    name: scn.name,
    stu: positions[scn.studentPositionId] || null,
    n: (scn.aircraft || []).length,
    air,
    gen,
    byAirport,
  };
}

/** Build the per-airport scenario entry the app consumes. */
export function scenarioForAirport(compact, apt) {
  const ac = compact.byAirport[apt];
  if (!ac || !ac.length) return null;
  return { id: compact.id, name: compact.name, stu: compact.stu, n: compact.n, air: compact.air, gen: compact.gen, ac };
}
