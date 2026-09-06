/* vNAS Ground Trainer — browser app.
   Loads any vNAS training airport (from the baked catalog, or live via a proxy),
   builds the taxiway graph in the browser, and runs the ground simulation. */
import { API, FILES, compactMap, compactScenario, facilityIndex, parseLenientJSON, scenarioForAirport, starsForAirport } from './lib/vnas.mjs';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const NS = 'http://www.w3.org/2000/svg';

/* ================= settings ================= */
const SET_KEY = 'vgt.settings';
const SET = {
  key: '', model: 'anthropic/claude-haiku-4.5', audioModel: 'google/gemini-3.5-flash-lite', proxy: '',
  tts: true, ttsEngine: 'browser', ttsModel: 'hexgrad/kokoro-82m', ttsVoice: '', voice: '', radio: true,
  mode: 'ground',
};
try { Object.assign(SET, JSON.parse(localStorage.getItem(SET_KEY) || '{}')); } catch { /* ignore */ }
function saveSettings() { try { localStorage.setItem(SET_KEY, JSON.stringify(SET)); } catch { /* ignore */ } }
const aiEnabled = () => !!(SET.key && SET.model);

/* ================= position: Ground (gold) or Tower (purple) ================= */
const MODES = {
  ground: { label: 'Ground', placeholder: "DAL1234 PUSH · or type it the way you'd say it on frequency", tips: (rw, tw) => `PUSH · RWY ${rw} TAXI ${tw} · CROSS · LUAW · CTO` },
  tower: { label: 'Local', placeholder: "DAL1234 CTO · or type it the way you'd say it on frequency", tips: () => 'LUAW · CTO · TRACK · CD · CTL · GA · FH 090 · CM 5000 · switch on Arrivals' },   /* mode key stays "tower" */
};
const modeInfo = () => MODES[SET.mode] || MODES.ground;
function applyMode() {
  if (!MODES[SET.mode]) SET.mode = 'ground';
  document.documentElement.dataset.mode = SET.mode;
  const m = $('#mode');
  m.value = SET.mode;
  /* a select is as wide as its widest option; shrink it to the word actually shown */
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:inherit';
  probe.textContent = modeInfo().label;
  m.parentElement.appendChild(probe);
  m.style.width = `${Math.ceil(probe.getBoundingClientRect().width) + 16}px`;
  probe.remove();
  $('#cmd').placeholder = modeInfo().placeholder;
  if (A) document.title = `${A.id} · vNAS ${modeInfo().label} Trainer`;
  /* tower gets the radar; which panes show is remembered separately */
  const view = SET.mode === 'tower' ? (SET.view || 'both') : 'ground';
  $('#scopes').dataset.view = view;
  document.querySelectorAll('#viewbar button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  requestAnimationFrame(() => { if (G) { fit(); sApply(); } });
}
if (document.fonts?.ready) document.fonts.ready.then(() => applyMode());

/* ================= data access ================= */
const cache = new Map();
async function getJSON(url, opts = {}) {
  if (cache.has(url)) return cache.get(url);
  const p = fetch(url, opts).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.split('?').pop().slice(0, 80)}`);
    return parseLenientJSON(await r.text());
  });
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}
const viaProxy = (url) => SET.proxy.includes('{url}') ? SET.proxy.replace('{url}', encodeURIComponent(url)) : SET.proxy + encodeURIComponent(url);
const vnas = (path) => getJSON(viaProxy(API + path));
const live = () => !!SET.proxy;

/* index: { built, artccs:[{id,name,airports:[{id,name,n}]}] } */
async function loadIndex() {
  if (!live()) return getJSON('catalog/index.json');
  const [artccs, airports, scen] = await Promise.all([
    vnas('/artcc-summaries'), vnas('/training/airport-summaries'), vnas('/training/scenario-summaries'),
  ]);
  const counts = {};
  for (const s of scen) if (s.primaryAirportId) counts[s.primaryAirportId] = (counts[s.primaryAirportId] || 0) + 1;
  const names = Object.fromEntries(artccs.map((a) => [a.id, a.name]));
  const by = {};
  for (const a of airports) (by[a.artccId] ||= []).push({ id: a.id, name: a.id, n: counts[a.id] || 0 });
  return {
    built: null,
    artccs: Object.keys(by).sort().map((id) => ({ id, name: names[id] || id, airports: by[id].sort((x, y) => x.id.localeCompare(y.id)) })),
  };
}

/* airport doc: { id, artcc, name, tower, asdex, twrmap, fleet, map, scen:[...] } */
async function loadAirport(id, artccId) {
  if (!live()) return getJSON(`catalog/airports/${id}.json`);
  const [artccDoc, apt, mapDoc, scen] = await Promise.all([
    vnas(`/artccs/${artccId}`), vnas(`/training/airports/${id}`), vnas(`/training/airports/${id}/map`), vnas('/training/scenario-summaries'),
  ]);
  const fi = facilityIndex(artccDoc);
  const fac = fi.facilities[id] || {};
  return {
    id, artcc: artccId, name: fac.name || id, tower: fac.tower || null, asdex: fac.asdex || null, twrmap: fac.twrmap || null,
    init: { jet: apt?.jetInitialAltitude || null, prop: apt?.propInitialAltitude || null, pattern: apt?.patternAltitude || null },
    stars: starsForAirport(fi, id),
    fleet: (apt?.trainingAircraftSets || []).map((s) => ({ a: s.airlineIcaoCode, w: s.weight || 1, t: s.aircraftTypeCodes || [] })),
    map: compactMap(mapDoc),
    scen: scen.filter((s) => s.primaryAirportId === id).map((s) => ({ id: s.id, name: s.name, lazy: true }))
      .sort((x, y) => x.name.localeCompare(y.name)),
    _positions: fi.positions,
  };
}
async function resolveScenario(doc, s) {
  if (!s.lazy) return s;
  const full = await vnas(`/training/scenarios/${s.id}`);
  const c = compactScenario(full, doc._positions || {});
  const out = scenarioForAirport(c, doc.id) || { id: s.id, name: s.name, stu: c.stu, n: c.n, air: c.air, gen: c.gen, ac: [] };
  Object.assign(s, out, { lazy: false });
  return s;
}

/* ================= graph ================= */
const TOL_FT = 100;
function buildGraph(map) {
  const all = [];
  map.taxi.forEach((t) => all.push(...t.c));
  map.rwy.forEach((r) => all.push(...r.c));
  Object.values(map.park).forEach((p) => all.push(p));
  Object.values(map.spot).forEach((p) => all.push(p));
  let lon0 = Infinity, lon1 = -Infinity, lat0 = Infinity, lat1 = -Infinity;
  for (const c of all) { lon0 = Math.min(lon0, c[0]); lon1 = Math.max(lon1, c[0]); lat0 = Math.min(lat0, c[1]); lat1 = Math.max(lat1, c[1]); }
  const latM = (lat0 + lat1) / 2;
  const FT_LAT = 364000, FT_LON = FT_LAT * Math.cos(latM * Math.PI / 180);
  const ft = (a, b) => Math.hypot((a[0] - b[0]) * FT_LON, (a[1] - b[1]) * FT_LAT);
  const bearing = (a, b) => (Math.atan2((b[0] - a[0]) * FT_LON, (b[1] - a[1]) * FT_LAT) * 180 / Math.PI + 360) % 360;
  const movePt = (c, brg, feet) => { const r = brg * Math.PI / 180; return [c[0] + Math.sin(r) * feet / FT_LON, c[1] + Math.cos(r) * feet / FT_LAT]; };

  /* cluster vertices within TOL_FT into nodes */
  const nodes = [], grid = new Map();
  const CX = TOL_FT / FT_LON, CY = TOL_FT / FT_LAT;
  function nodeFor(c) {
    const gx = Math.floor(c[0] / CX), gy = Math.floor(c[1] / CY);
    let best = null, bd = TOL_FT;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of grid.get((gx + dx) + ',' + (gy + dy)) || []) { const d = ft(nodes[i], c); if (d < bd) { bd = d; best = i; } }
    }
    if (best != null) return best;
    nodes.push([c[0], c[1]]);
    const k = gx + ',' + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(nodes.length - 1);
    return nodes.length - 1;
  }
  const chainOf = (coords) => { const ch = coords.map(nodeFor); return ch.filter((n, i) => i === 0 || n !== ch[i - 1]); };
  const edges = new Map();
  const tw = {}, rwChain = {}, rwset = new Set();
  for (const t of map.taxi) {
    const ch = chainOf(t.c);
    for (let i = 0; i + 1 < ch.length; i++) edges.set(Math.min(ch[i], ch[i + 1]) + '-' + Math.max(ch[i], ch[i + 1]), t.n);
    (tw[t.n] ||= new Set()); ch.forEach((n) => tw[t.n].add(n));
  }
  for (const r of map.rwy) {
    const ch = chainOf(r.c);
    if (ch.length < 2) continue;
    rwset.add(r.n); rwChain[r.n] = ch;
    for (let i = 0; i + 1 < ch.length; i++) edges.set(Math.min(ch[i], ch[i + 1]) + '-' + Math.max(ch[i], ch[i + 1]), r.n);
  }
  const adj = {};
  for (const [k, nm] of edges) {
    const [a, b] = k.split('-').map(Number);
    const w = Math.round(ft(nodes[a], nodes[b]) * 10) / 10;
    (adj[a] ||= []).push([b, w, nm]); (adj[b] ||= []).push([a, w, nm]);
  }
  const rwy = {};
  for (const nm in rwChain) {
    const e = nm.split('-');
    rwy[e[0]] = { rw: nm, chain: rwChain[nm] };
    if (e[1]) rwy[e[1]] = { rw: nm, chain: [...rwChain[nm]].reverse() };
  }
  /* largest connected component — gates attach to it */
  const seen = new Set(); let main = [];
  for (let n = 0; n < nodes.length; n++) {
    if (seen.has(n)) continue;
    const comp = []; const st = [n]; seen.add(n);
    while (st.length) { const x = st.pop(); comp.push(x); for (const [m] of adj[x] || []) if (!seen.has(m)) { seen.add(m); st.push(m); } }
    if (comp.length > main.length) main = comp;
  }
  const attach = (c) => { let bn = 0, bd = Infinity; for (const i of main) { const d = ft(nodes[i], c); if (d < bd) { bd = d; bn = i; } } return bn; };
  const park = {};
  for (const [nm, p] of Object.entries(map.spot)) park[nm] = { c: [p[0], p[1]], h: p[2], n: attach(p), spot: true };
  for (const [nm, p] of Object.entries(map.park)) park[nm] = { c: [p[0], p[1]], h: p[2], n: attach(p) };
  const twOut = {}; for (const nm in tw) if (!rwset.has(nm)) twOut[nm] = [...tw[nm]];
  return { nodes, adj, rwy, rwset, tw: twOut, park, ft, bearing, movePt, FT_LAT, FT_LON, bounds: { lon0, lon1, lat0, lat1 } };
}

/* ================= state ================= */
let INDEX = null;        /* catalog index */
let A = null;            /* current airport doc */
let G = null;            /* graph */
let NODES, ADJ, TW, NODE_TW, RWSET, GATES, GATE_NAMES, ftBetween, bearing, movePt;
let WORLD_W = 1000, WORLD_H = 1000, U = 1, P = (c) => c;
const S = { t: 0, running: true, rate: 1, arrivals: false, sel: null, ac: [], seq: 0, tick: 0 };
let CUR_SCEN = null;

function edgeName(a, b) { for (const [m, , nm] of ADJ[a] || []) if (m === b) return nm; return null; }

function astar(start, goal, opts = {}) {
  const prefer = opts.prefer ? new Set(opts.prefer) : null;
  const rwPen = opts.rwPen == null ? 6000 : opts.rwPen;
  const open = [[0, 0, start]], best = { [start]: 0 }, par = { [start]: null };
  const h = (n) => ftBetween(NODES[n], NODES[goal]);
  while (open.length) {
    open.sort((a, b) => a[0] - b[0]);
    const [, c, n] = open.shift();
    if (n === goal) break;
    if (c > best[n]) continue;
    for (const [m, w, nm] of ADJ[n] || []) {
      let cost = w;
      if (RWSET.has(nm)) cost += rwPen;
      else if (prefer && !prefer.has(nm)) cost += w * 1.5 + 380;
      const nc = c + cost;
      if (best[m] === undefined || nc < best[m]) { best[m] = nc; par[m] = n; open.push([nc + h(m), nc, m]); }
    }
  }
  if (par[goal] === undefined) return null;
  const out = []; let x = goal;
  while (x !== null && x !== undefined) { out.push(x); x = par[x]; }
  return out.reverse();
}
const listFor = (name) => TW[name] || (G.rwy[name] ? G.rwy[name].chain : null);
function nearestOn(name, from) {
  const list = listFor(name); if (!list || !list.length) return null;
  let bn = null, bd = Infinity;
  for (const n of list) { const d = ftBetween(NODES[n], NODES[from]); if (d < bd) { bd = d; bn = n; } }
  return bn;
}
function farthestOn(name, from) {
  const list = listFor(name); if (!list || !list.length) return null;
  let bn = null, bd = -1;
  for (const n of list) { const d = ftBetween(NODES[n], NODES[from]); if (d > bd) { bd = d; bn = n; } }
  return bn;
}
/* The named taxiways are a routing bias, not hard waypoints: one A* to the
   destination that prefers them. */
function routeVia(from, names, finalNode) {
  const prefer = new Set(names);
  for (const nm of names) if (!TW[nm] && !G.rwy[nm]) return { err: `unfamiliar with ${nm}` };
  let goal = finalNode;
  if (goal == null) {
    if (!names.length) return { err: 'taxi where?' };
    goal = farthestOn(names[names.length - 1], from);
    if (goal == null) return { err: `unfamiliar with ${names[names.length - 1]}` };
  }
  const path = astar(from, goal, { prefer });
  if (!path || path.length < 2) return { err: 'no route from here' };
  return { path };
}
function nearestNode(c) {
  let bn = 0, bd = Infinity;
  for (let i = 0; i < NODES.length; i++) { const d = ftBetween(NODES[i], c); if (d < bd) { bd = d; bn = i; } }
  return bn;
}
/* the last non-runway node before entering the runway from this side */
function holdNodeFor(rwyDesig) {
  const info = G.rwy[rwyDesig]; if (!info) return null;
  for (const n of info.chain) {
    let bn = null, bd = Infinity;
    for (const [m, w, nm] of ADJ[n] || []) { if (RWSET.has(nm)) continue; if (w < bd) { bd = w; bn = m; } }
    if (bn != null) return bn;
  }
  return info.chain[0];
}

/* ================= aircraft ================= */
function Aircraft(o) {
  return Object.assign({
    id: ++S.seq, cs: '', ty: '', state: 'PARKED', pos: [0, 0], hdg: 0, spd: 0,
    path: null, leg: 0, frac: 0, holdLeg: null, cleared: new Set(), blockedBy: null,
    breakUntil: -1, giveway: null, delay: 0, gate: null, rwy: null, dep: null, dst: null,
    sq: '1200', xpdr: 'S', hist: [],
    /* flight: altitude ft, targets, turn direction, radar track state */
    alt: 0, tgtAlt: 0, tgtHdg: 0, tgtSpd: 0, vs: 0, turn: null,
    tracked: false, handoff: false, handoffAt: 0, ctl: false, radar: null,
  }, o);
}
/* ---- flight performance: enough to fly a departure or a go-around ---- */
const PROP_TYPES = /^(C1\d\d|C2\d\d|C3\d\d|C4\d\d|P\d{2}|PA\d\d|BE\d\d|B190|SW[234]|AT[47]\d|DH8|SF34|E120|C208|PC12|TBM|SR2\d|DA4\d|DA62|M20|AC\d|J328|D328|AN\d|L410|C441|MU2|PAY\d|P180)/;
const isProp = (ty) => PROP_TYPES.test(String(ty || ''));
function perf(a) {
  const prop = isProp(a.ty);
  return {
    prop, vr: prop ? 65 : 135, accel: prop ? 4 : 6, climbSpd: prop ? 140 : 250, vs: prop ? 1000 : 2500,
    initAlt: (prop ? A?.init?.prop : A?.init?.jet) || 5000,
  };
}
function rwyCourse(rw) {
  const info = G.rwy[rw]; if (!info || info.chain.length < 2) return null;
  return bearing(NODES[info.chain[0]], NODES[info.chain[1]]);
}
function liftoff(a) {
  const pf = perf(a);
  const crs = rwyCourse(a.rwy) ?? a.hdg;
  a.state = 'AIRB'; a.hdg = crs; a.tgtHdg = crs; a.turn = null;
  a.alt = 0; a.tgtAlt = pf.initAlt; a.tgtSpd = pf.climbSpd; a.vs = pf.vs;
  a.path = null; a.holdLeg = null; a.xpdr = a.xpdr === 'S' ? 'N' : a.xpdr; a.airborneAt = S.t;
  line('sys', '', `${a.cs} airborne runway ${a.rwy}, climbing ${a.tgtAlt}`);
}
function goAround(a, why) {
  const crs = rwyCourse(a.rwy) ?? a.hdg;
  a.state = 'AIRB'; a.hdg = crs; a.tgtHdg = crs; a.turn = null;
  a.alt = Math.max(a.alt || 0, 50); a.tgtAlt = Math.max(3000, (A?.init?.pattern || 0) + 1500);
  a.tgtSpd = 160; a.vs = perf(a).vs; a.path = null; a.ctl = false; a.destGate = null; a.goaround = true;
  say(a, why ? `going around, ${why}` : 'going around', 'pilot');
}
function removeAc(a, msg) {
  a.state = 'DEP'; a.radar = null;
  S.ac = S.ac.filter((x) => x !== a);
  if (S.sel === a) { S.sel = null; syncSel(); }
  if (msg) line('sys', '', msg);
}
function stepAir(a, dt) {
  let d = ((a.tgtHdg - a.hdg + 540) % 360) - 180;
  if (a.turn === 'L' && d > 0) d -= 360;
  if (a.turn === 'R' && d < 0) d += 360;
  const rate = 3 * dt;
  if (Math.abs(d) <= rate) { a.hdg = a.tgtHdg; a.turn = null; } else a.hdg = (a.hdg + Math.sign(d) * rate + 360) % 360;
  a.spd = a.spd < a.tgtSpd ? Math.min(a.tgtSpd, a.spd + 3 * dt) : Math.max(a.tgtSpd, a.spd - 2 * dt);
  const vs = (a.vs || 2000) / 60 * dt;
  if (a.alt < a.tgtAlt) a.alt = Math.min(a.tgtAlt, a.alt + vs);
  else if (a.alt > a.tgtAlt) a.alt = Math.max(a.tgtAlt, a.alt - vs * 0.6);
  a.pos = movePt(a.pos, a.hdg, a.spd * 1.68781 * dt);
  if (S.tick % 10 === 0) { a.hist.push(a.pos.slice()); if (a.hist.length > 6) a.hist.shift(); }
  if (a.handoff && S.t - a.handoffAt > 20) { removeAc(a, `${a.cs} with ${A.stars?.dep?.radio || 'departure'}`); return; }
  const distNm = RC ? Math.hypot(...PS(a.pos)) : 0;
  if (distNm > 16) removeAc(a, `${a.cs} left the area${a.handoff ? '' : ' without a frequency change'}`);
}
const findAc = (q) => {
  q = String(q || '').toUpperCase();
  let hit = S.ac.filter((a) => a.cs === q);
  if (hit.length === 1) return hit[0];
  hit = S.ac.filter((a) => a.cs.endsWith(q) || a.cs.startsWith(q));
  return hit.length === 1 ? hit[0] : null;
};
function legRwy(a, i) { const p = a.path; return p && i + 1 < p.length ? edgeName(p[i], p[i + 1]) : null; }
function firstRwyLeg(a, from) {
  const p = a.path; if (!p) return null;
  for (let i = from; i + 1 < p.length; i++) { const nm = edgeName(p[i], p[i + 1]); if (RWSET.has(nm) && !a.cleared.has(nm)) return i; }
  return null;
}
function setPathFrom(a, nodes) {
  a.path = nodes.slice(); a.leg = 0; a.frac = 0; a._origin = a.pos.slice(); a.holdLeg = firstRwyLeg(a, 0);
}
function legPts(a, i) {
  const p = a.path;
  return [(i === 0 && a._origin) ? a._origin : NODES[p[i]], NODES[p[i + 1]]];
}

/* ================= physics ================= */
const TAXI_KT = 16, TURN_KT = 9, PUSH_KT = 4, ROLL_KT = 150, HOLD_FT = 340;
function aheadConflict(a) {
  if (S.t < a.breakUntil) return null;
  for (const b of S.ac) {
    if (b === a || b.state === 'PARKED' || b.state === 'DEP' || b.state === 'FINAL' || b.state === 'AIRB' || b.delay > 0) continue;
    const d = ftBetween(a.pos, b.pos);
    if (d > HOLD_FT || d < 1) continue;
    const rel = (bearing(a.pos, b.pos) - a.hdg + 540) % 360 - 180;
    if (Math.abs(rel) < 38) return b;
  }
  return null;
}
function turnAhead(a) {
  const p = a.path; if (!p || a.leg + 2 >= p.length) return 0;
  const [c, d] = legPts(a, a.leg), e = NODES[p[a.leg + 2]] || d;
  return Math.abs((bearing(d, e) - bearing(c, d) + 540) % 360 - 180);
}
function step(a, dt) {
  if (a.delay > 0) {
    a.delay -= dt;
    if (a.delay <= 0) line('sys', '', `${a.cs} ${a.ty} on frequency — ${a.gate ? `at ${a.gate}` : a.rwy ? `holding short ${a.rwy}` : 'ready'}`);
    return;
  }
  if (a.state === 'PARKED' || a.state === 'DEP') return;
  if (a.state === 'AIRB') { stepAir(a, dt); return; }
  if (a.state === 'TKOF') {
    const pf = perf(a);
    a.spd = Math.min(ROLL_KT, a.spd + pf.accel * dt); advance(a, dt);
    if (a.spd >= pf.vr || !a.path || a.leg >= a.path.length - 1) liftoff(a);
    return;
  }
  if (a.state === 'FINAL') {
    a.spd = 140; advance(a, dt);
    if (a.leg >= 1) { a.alt = 0; a.landed = true; }          /* leg 0 is the approach; leg 1+ is the runway */
    else {
      const info = G.rwy[a.rwy];
      const dnm = info ? ftBetween(a.pos, NODES[info.chain[0]]) / 6076 : 0;
      a.alt = Math.max(0, dnm * 318);                            /* 3° glide */
      if (SET.mode === 'tower' && !a.ctl && dnm < 1.0) { goAround(a, 'no landing clearance'); return; }
    }
    if (!a.path || a.leg >= a.path.length - 1) { a.state = 'ROLLOUT'; a.alt = 0; }
    return;
  }
  if (a.state === 'ROLLOUT') {
    a.spd = Math.max(18, a.spd - 9 * dt); advance(a, dt);
    if (a.spd <= 19) autoExit(a);
    return;
  }
  if (a.state === 'HOLD' || a.state === 'LUAW' || a.state === 'PUSHED' || a.state === 'SHORT') { a.spd = Math.max(0, a.spd - 14 * dt); return; }

  const conflict = a.giveway ? (S.ac.find((x) => x.cs === a.giveway) || null) : aheadConflict(a);
  const holdHere = a.holdLeg != null && a.leg >= a.holdLeg;
  let want = a.state === 'PUSH' ? PUSH_KT : (turnAhead(a) > 32 ? TURN_KT : TAXI_KT);
  if (holdHere) want = 0;
  if (conflict && a.state !== 'PUSH') {
    const d = ftBetween(a.pos, conflict.pos);
    want = d < 180 ? 0 : Math.min(want, 7);
    a.blockedBy = conflict.cs;
  } else a.blockedBy = null;
  if (a.giveway && conflict && ftBetween(a.pos, conflict.pos) > 420) a.giveway = null;

  a.spd = a.spd < want ? Math.min(want, a.spd + 5 * dt) : Math.max(want, a.spd - 8 * dt);
  if (holdHere && a.spd < 0.4) {
    a.spd = 0;
    if (a.state !== 'SHORT') {
      a.state = 'SHORT';
      const nm = legRwy(a, a.holdLeg);
      say(a, `holding short of ${a.rwy || nm ? `{r:${a.rwy || nm}}` : 'the runway'}`, 'pilot');
    }
    return;
  }
  if (!a.path) { a.spd = 0; a.state = 'HOLD'; return; }
  advance(a, dt);
  if (a.leg >= a.path.length - 1) arriveEnd(a);
}
function advance(a, dt) {
  if (!a.path) return;
  let move = a.spd * 1.68781 * dt;
  while (move > 0 && a.leg < a.path.length - 1) {
    const [c, d] = legPts(a, a.leg);
    const len = Math.max(ftBetween(c, d), 1);
    const rem = (1 - a.frac) * len;
    if (move < rem) { a.frac += move / len; move = 0; }
    else {
      move -= rem; a.leg++; a.frac = 0; a._origin = null;
      if (a.holdLeg != null && a.leg > a.holdLeg) a.holdLeg = firstRwyLeg(a, a.leg);
    }
  }
  if (a.leg < a.path.length - 1) {
    const [c, d] = legPts(a, a.leg);
    a.pos = [c[0] + (d[0] - c[0]) * a.frac, c[1] + (d[1] - c[1]) * a.frac];
    const br = bearing(c, d);
    a.hdg = a.state === 'PUSH' ? (br + 180) % 360 : br;
  } else a.pos = NODES[a.path[a.path.length - 1]].slice();
  if (S.tick % 10 === 0) { a.hist.push(a.pos.slice()); if (a.hist.length > 6) a.hist.shift(); }
}
function arriveEnd(a) {
  if (a.state === 'PUSH') { a.state = 'PUSHED'; a.spd = 0; say(a, 'ready to taxi', 'pilot'); return; }
  if (a.state === 'TAXI' || a.state === 'SHORT') {
    a.spd = 0;
    if (a._luaw) { a._luaw = false; a.state = 'LUAW'; say(a, `lined up runway {r:${a.rwy}}`, 'pilot'); return; }
    if (a.destGate) { a.state = 'PARKED'; a.gate = a.destGate; a.destGate = null; say(a, `in the blocks at {g:${a.gate}}`, 'pilot'); return; }
    if (a.rwy) { a.state = 'SHORT'; say(a, `holding short of {r:${a.rwy}}`, 'pilot'); return; }
    a.state = 'HOLD'; say(a, 'holding', 'pilot');
  }
}
function autoExit(a) {
  const chain = G.rwy[a.rwy] ? G.rwy[a.rwy].chain : null;
  let bestNode = null, bd = Infinity;
  for (const n of chain || []) {
    for (const [m, , nm] of ADJ[n] || []) {
      if (RWSET.has(nm)) continue;
      const d = ftBetween(NODES[m], a.pos);
      if (d < bd) { bd = d; bestNode = m; }
    }
  }
  a.spd = 6;
  if (bestNode == null) { a.state = 'HOLD'; a.rwy = null; say(a, 'clear of the runway', 'pilot'); return; }
  a.cleared.add(G.rwy[a.rwy].rw);
  const r = astar(nearestNode(a.pos), bestNode, { rwPen: 0 });
  if (r) { setPathFrom(a, r); a.state = 'TAXI'; a.holdLeg = null; } else a.state = 'HOLD';
  a.rwy = null;
  say(a, `clear of the runway${NODE_TW[bestNode] ? ` at {t:${[...NODE_TW[bestNode]][0]}}` : ''}`, 'pilot');
}

/* ================= log ================= */
const LOG = $('#log');
function line(kind, who, msg) {
  const el = document.createElement('div');
  el.className = 'line ' + kind;
  const mm = String(Math.floor(S.t / 60)).padStart(2, '0'), ss = String(Math.floor(S.t % 60)).padStart(2, '0');
  el.innerHTML = `<span class="t">${mm}:${ss}</span><span class="m">${who ? `<span class="who">${esc(who)}</span> ` : ''}${esc(plain(msg))}</span>`;
  LOG.prepend(el);
  while (LOG.children.length > 140) LOG.lastChild.remove();
  return el;
}
/* ---- phraseology markup ----
   Sim messages tag identifiers so the log shows the written form and the voice
   says the spoken one:  {r:30L} runway  {t:A1} taxiway  {g:E16} gate/spot
   {f:124.700} frequency  {n:4521} digits  {c:DAL1047} callsign. */
const MARK_RE = /\{([rtgfnc]):([^}]*)\}/g;
const RW_SIDE = { L: 'left', R: 'right', C: 'center' };
const spellOut = (t) => [...String(t)].map((c) => NATO[c] || c).join(' ');
const spokenRunway = (t) => String(t).split('-').map((p) => {
  const m = /^(\d{1,2})([LRC])?$/.exec(p);
  return m ? `${digitsWords(m[1])}${m[2] ? ' ' + RW_SIDE[m[2]] : ''}` : spellOut(p);
}).join(', ');
/* single letters and short alphanumerics are spelled; a long name like ALLEY is a word;
   a space-separated list ("Q C W3") gets a pause between items */
const spokenIdent = (t) => String(t).trim().split(/\s+/).map((x) => (/^[A-Z]{5,}$/.test(x) ? x.toLowerCase() : spellOut(x))).join(', ');
const spokenFreq = (t) => { const [a, b = ''] = String(t).split('.'); const frac = b.replace(/0+$/, '') || '0'; return `${digitsWords(a)} point ${digitsWords(frac)}`; };
const plain = (s) => String(s).replace(MARK_RE, (_, k, v) => v);
const spoken = (s) => String(s).replace(MARK_RE, (_, k, v) =>
  k === 'r' ? spokenRunway(v) : (k === 't' || k === 'g') ? spokenIdent(v) : k === 'f' ? spokenFreq(v)
    : k === 'n' ? digitsWords(v) : k === 'c' ? spokenCallsign(v) : v);
/* best effort for free text the model wrote without a spoken form */
function spokenFallback(s) {
  const names = Object.values(TELEPHONY).join('|').replace(/ /g, '\\s');
  return String(s || '')
    .replace(new RegExp(`\\b(${names})\\s+(\\d{1,4})([A-Z]{0,2})\\b`, 'g'), (m, n, d, sfx) => `${n} ${groupNumber(d)}${sfx ? ' ' + spell(sfx) : ''}`)
    .replace(/\b([A-Z]{3})(\d{1,4})([A-Z]{0,2})\b/g, (m) => spokenCallsign(m))       /* a written callsign like DAL1047 */
    .replace(/\bN(\d[0-9A-Z]{1,5})\b/g, (m) => spell(m))
    .replace(/\b(\d{3})\.(\d{1,3})\b/g, (m) => spokenFreq(m))
    .replace(/\b(runway|rwy)\s+(\d{1,2}[LRC]?)\b/gi, (m, w, r) => `runway ${spokenRunway(r.toUpperCase())}`)
    .replace(/\b(\d{1,2})([LRC])\b/g, (m, d, s) => `${digitsWords(d)} ${RW_SIDE[s]}`)
    .replace(/\b(squawk(?:ing)?|heading)\s+(\d{3,4})\b/gi, (m, w, d) => `${w} ${digitsWords(d)}`)
    .replace(/\b(via|taxiway|short of|hold short|at|exit at|gate|spot)\s+((?:[A-Z]{1,2}\d{0,2}\b[\s,]*)+)/g,
      (m, w, list) => `${w} ${list.replace(/\b([A-Z]{1,2}\d{0,2})\b/g, (t) => spellOut(t))}`);
}

/* While an AI-translated transmission executes, the per-command pilot replies are
   suppressed: the model's single readback stands in for all of them. */
let quiet = 0;
const say = (a, msg, kind) => {
  const k = kind || 'pilot';
  if (k === 'pilot' && quiet) return null;
  const el = line(k, a.cs, msg);
  if (k === 'pilot') speak(a, spoken(msg), { raw: String(msg).includes(`{c:${a.cs}}`) });
  return el;
};

/* ================= commands ================= */
function resolveTaxiTokens(toks) {
  const path = []; let gate = null;
  for (const t of toks) {
    const T = t.toUpperCase();
    if (TW[T]) path.push(T);
    else if (GATES[T]) gate = T;
    else if (G.rwy[T]) path.push(G.rwy[T].rw);
    else return { err: `unfamiliar with ${T}` };
  }
  return { path, gate };
}
function beginTaxi(a, names, gate, rwy) {
  const from = a.state === 'PARKED' ? GATES[a.gate].n : nearestNode(a.pos);
  let finalNode = null;
  if (gate) finalNode = GATES[gate].n;
  else if (rwy) finalNode = holdNodeFor(rwy);
  const r = routeVia(from, names, finalNode);
  if (r.err) return r.err;
  if (a.state === 'PARKED') { a.pos = GATES[a.gate].c.slice(); }
  a.cleared = new Set();
  setPathFrom(a, r.path);
  a.destGate = gate || null; a.rwy = rwy || null; a.state = 'TAXI'; a.giveway = null;
  return null;
}
/* Adjacent taxiways share junction nodes, so an edge there can carry either name.
   Absorb a short run that is flanked by the same taxiway on both sides. */
function routeSummary(a) {
  if (!a.path) return '';
  const runs = []; let prev = null;
  for (let i = 0; i + 1 < a.path.length; i++) {
    const nm = edgeName(a.path[i], a.path[i + 1]); if (!nm) continue;
    const d = ftBetween(NODES[a.path[i]], NODES[a.path[i + 1]]);
    if (nm !== prev) { runs.push([nm, 0]); prev = nm; }
    runs[runs.length - 1][1] += d;
  }
  for (let i = 1; i < runs.length - 1; i++) {
    if (runs[i - 1][0] === runs[i + 1][0] && runs[i][1] < 1400) { runs[i - 1][1] += runs[i][1] + runs[i + 1][1]; runs.splice(i, 2); i--; }
  }
  const out = [];
  for (const [nm, d] of runs) {
    if (d < 300 && out.length && runs.length > 2) continue;
    if (out[out.length - 1] !== nm) out.push(nm);
  }
  /* runs of taxiways share one tag so the spoken form pauses between them */
  const parts = [];
  for (const nm of out) {
    if (RWSET.has(nm)) parts.push(`{r:${nm}}`);
    else if (parts.length && parts[parts.length - 1].startsWith('{t:')) parts[parts.length - 1] = parts[parts.length - 1].replace(/\}$/, ` ${nm}}`);
    else parts.push(`{t:${nm}}`);
  }
  return parts.join(' ');
}

const CMDS = {
  PUSH(a, args) {
    if (a.state !== 'PARKED') return 'not at a gate';
    const spot = GATES[a.gate]; if (!spot) return 'gate unknown';
    a._origin = spot.c.slice(); a.pos = spot.c.slice(); a.hdg = spot.h;
    let target = spot.n;
    if (args[0]) { const n = nearestOn(args[0].toUpperCase(), spot.n); if (n != null) target = n; }
    let nodes;
    if (target === spot.n) nodes = [spot.n, spot.n];
    else { const r = astar(spot.n, target, { rwPen: 9e5 }); nodes = (r && r.length > 1) ? r : [spot.n, spot.n]; }
    a.path = nodes; a.leg = 0; a.frac = 0; a.holdLeg = null; a.state = 'PUSH';
    say(a, `pushing back off {g:${a.gate}}`, 'pilot'); return null;
  },
  TAXI(a, args) {
    const hsAt = args.findIndex((t) => t.toUpperCase() === 'HS');
    const toks = hsAt >= 0 ? args.slice(0, hsAt) : args;
    if (!toks.length) return 'taxi where?';
    const r = resolveTaxiTokens(toks); if (r.err) return r.err;
    const err = beginTaxi(a, r.path, r.gate, null); if (err) return err;
    if (hsAt >= 0 && args[hsAt + 1]) CMDS.HS(a, [args[hsAt + 1]]);
    say(a, `taxi via ${routeSummary(a) || 'the ramp'}`, 'pilot'); return null;
  },
  RWY(a, args) {
    if (!args.length) return 'which runway?';
    const rw = args[0].toUpperCase();
    if (!G.rwy[rw]) return `no runway ${rw}`;
    let rest = args.slice(1);
    if (rest[0] && rest[0].toUpperCase() === 'TAXI') rest = rest.slice(1);
    const hsAt = rest.findIndex((t) => t.toUpperCase() === 'HS');
    const toks = hsAt >= 0 ? rest.slice(0, hsAt) : rest;
    const r = resolveTaxiTokens(toks); if (r.err) return r.err;
    const err = beginTaxi(a, r.path, null, rw); if (err) return err;
    if (hsAt >= 0 && rest[hsAt + 1]) CMDS.HS(a, [rest[hsAt + 1]]);
    say(a, `runway {r:${rw}}, taxi via ${routeSummary(a) || 'the field'}`, 'pilot'); return null;
  },
  HS(a, args) {
    if (!args.length || !a.path) return 'hold short of what?';
    const T = args[0].toUpperCase();
    for (let i = a.leg; i + 1 < a.path.length; i++) {
      const nm = edgeName(a.path[i], a.path[i + 1]);
      if (nm === T || nm === (G.rwy[T] && G.rwy[T].rw)) { a.holdLeg = i; say(a, `hold short of ${G.rwy[T] || RWSET.has(T) ? `{r:${T}}` : `{t:${T}}`}`, 'pilot'); return null; }
    }
    return `${T} is not on the route`;
  },
  CROSS(a, args) {
    const nm = a.holdLeg != null ? edgeName(a.path[a.holdLeg], a.path[a.holdLeg + 1]) : (a.rwy ? G.rwy[a.rwy].rw : null);
    if (!nm) return 'not holding short of anything';
    a.cleared.add(nm);
    a.holdLeg = firstRwyLeg(a, a.leg);
    if (a.state === 'SHORT') a.state = 'TAXI';
    say(a, `crossing {r:${args[0] ? args[0].toUpperCase() : nm}}`, 'pilot'); return null;
  },
  RES(a) {
    if (a.holdLeg != null) return CMDS.CROSS(a, []);
    if (a.state === 'HOLD' || a.state === 'PUSHED' || a.state === 'SHORT') {
      if (!a.path || a.leg >= a.path.length - 1) return 'no route to resume — give a taxi instruction';
      a.state = 'TAXI'; a.giveway = null; say(a, 'continuing', 'pilot'); return null;
    }
    return 'already moving';
  },
  HOLD(a) { a.state = 'HOLD'; say(a, 'holding', 'pilot'); return null; },
  BREAK(a) { a.breakUntil = S.t + 15; a.giveway = null; if (a.state === 'HOLD') a.state = 'TAXI'; say(a, 'coming through', 'pilot'); return null; },
  GIVEWAY(a, args) {
    if (!args.length) return 'give way to whom?';
    const o = findAc(args[0]); if (!o) return `no aircraft ${args[0]}`;
    a.giveway = o.cs; say(a, `giving way to {c:${o.cs}}`, 'pilot'); return null;
  },
  GW(a, args) { return CMDS.GIVEWAY(a, args); },
  LUAW(a) {
    if (!a.rwy) return 'no departure runway assigned — use RWY first';
    const info = G.rwy[a.rwy];
    a.cleared.add(info.rw);
    const r = astar(nearestNode(a.pos), info.chain[0], { rwPen: 0 });
    if (!r) return 'cannot reach the runway';
    setPathFrom(a, r); a.holdLeg = null; a.state = 'TAXI'; a._luaw = true;
    say(a, 'line up and wait', 'pilot'); return null;
  },
  CTO(a) {
    if (!a.rwy) return 'no departure runway assigned';
    const info = G.rwy[a.rwy];
    a.cleared.add(info.rw);
    const near = nearestNode(a.pos);
    const onRwy = info.chain.includes(near);
    const startNode = onRwy ? near : info.chain[0];
    const chain = info.chain.slice(info.chain.indexOf(startNode));
    if (!onRwy) {
      const r = astar(near, info.chain[0], { rwPen: 0 });
      if (!r) return 'cannot reach the runway';
      setPathFrom(a, r.concat(chain.slice(1)));
    } else setPathFrom(a, chain);
    a.holdLeg = null; a.state = 'TKOF'; a._luaw = false;
    say(a, `cleared for takeoff runway {r:${a.rwy}}`, 'pilot'); return null;
  },
  EXIT(a) {
    if (a.state !== 'ROLLOUT' && a.state !== 'HOLD') return 'not on a landing roll';
    autoExit(a); return null;
  },
  GA(a) {
    if (a.state !== 'FINAL' || a.landed) return 'not on final';
    goAround(a); return null;
  },
  /* ---- tower ---- */
  CTL(a) {
    if (a.state !== 'FINAL' || a.landed) return 'not on final';
    a.ctl = true; say(a, `cleared to land runway {r:${a.rwy}}`, 'pilot'); return null;
  },
  TRACK(a) {
    if (!a.radar) return 'no radar target';
    a.tracked = true; line('sys', '', `${a.cs} tracked`); renderStars(); return null;
  },
  IC(a) { return CMDS.TRACK(a); },
  DROP(a) { a.tracked = false; line('sys', '', `${a.cs} track dropped`); renderStars(); return null; },
  DT(a) { return CMDS.DROP(a); },
  CD(a) {
    if (a.state !== 'AIRB' && a.state !== 'TKOF') return 'not airborne';
    if (a.handoff) return 'already switched';
    a.handoff = true; a.handoffAt = S.t;
    const d = A.stars?.dep;
    say(a, d ? `over to ${d.radio || 'departure'}${d.freq ? ` {f:${d.freq}}` : ''}` : 'contact departure', 'pilot');
    renderStars(); return null;
  },
  FH(a, args) { return flyHeading(a, args[0], null); },
  TL(a, args) { return flyHeading(a, args[0], 'L'); },
  TR(a, args) { return flyHeading(a, args[0], 'R'); },
  CM(a, args) {
    if (a.state !== 'AIRB') return 'not airborne';
    const alt = parseAlt(args[0]); if (alt == null) return 'altitude?';
    a.tgtAlt = alt; say(a, `${alt > a.alt ? 'climb' : 'descend'} and maintain ${altWords(alt)}`, 'pilot'); return null;
  },
  SQ(a, args) { if (!args[0]) return 'squawk what?'; a.sq = args[0]; a.xpdr = 'N'; say(a, `squawking {n:${a.sq}}`, 'pilot'); return null; },
  SN(a) { a.xpdr = 'N'; say(a, 'squawking normal', 'pilot'); return null; },
  SS(a) { a.xpdr = 'S'; say(a, 'squawk standby', 'pilot'); return null; },
  ID(a) { a.xpdr = 'I'; say(a, 'ident', 'pilot'); setTimeout(() => { if (a.xpdr === 'I') a.xpdr = 'N'; }, 4000); return null; },
  SAY(a, args) {
    const w = (args[0] || '').toUpperCase();
    if (w === 'GATE') say(a, a.gate ? `we're at {g:${a.gate}}` : `we're not at a gate`, 'pilot');
    else if (w === 'TYPE') say(a, `we're a ${a.ty}`, 'pilot');
    else if (w === 'RWY' || w === 'RUNWAY') say(a, a.rwy ? `expecting runway {r:${a.rwy}}` : 'no runway assigned', 'pilot');
    else say(a, `${a.ty} at ${a.gate ? `{g:${a.gate}}` : 'the ramp'}, ${a.dep || A.id} to ${a.dst || '—'}`, 'pilot');
    return null;
  },
  DEL(a) { S.ac = S.ac.filter((x) => x !== a); if (S.sel === a) S.sel = null; line('sys', '', `${a.cs} deleted`); return null; },
  PAUSE() { setRunning(false); return null; },
  UNPAUSE() { setRunning(true); return null; },
  SIMRATE(a, args) { S.rate = Math.max(1, Math.min(8, parseInt(args[0] || '1', 10) || 1)); syncChrome(); return null; },
  TAXIALL() {
    let n = 0;
    S.ac.forEach((a) => { if (a.state === 'HOLD' && a.path && a.leg < a.path.length - 1) { a.state = 'TAXI'; a.giveway = null; n++; } });
    line('sys', '', `${n} aircraft resumed`); return null;
  },
};
const GLOBAL_CMDS = new Set(['PAUSE', 'UNPAUSE', 'TAXIALL', 'SIMRATE']);
const digitsWords = (n) => [...String(n)].map((d) => NATO[d] || d).join(' ');
function flyHeading(a, arg, dir) {
  if (a.state !== 'AIRB') return 'not airborne';
  const h = parseInt(arg, 10);
  if (!Number.isFinite(h) || h < 1 || h > 360) return 'heading?';
  a.tgtHdg = h % 360; a.turn = dir;
  say(a, `${dir === 'L' ? 'turn left ' : dir === 'R' ? 'turn right ' : ''}heading {n:${String(h).padStart(3, '0')}}`, 'pilot');
  return null;
}
function parseAlt(s) {
  s = String(s || '').toUpperCase();
  if (/^FL\d{2,3}$/.test(s)) return parseInt(s.slice(2), 10) * 100;
  const n = parseInt(s, 10); if (!Number.isFinite(n) || n <= 0) return null;
  return n <= 450 ? n * 100 : n;                         /* "50" and "FL050" both mean 5,000 */
}
function altWords(alt) {
  if (alt >= 18000) return `flight level ${digitsWords(Math.round(alt / 100))}`;
  const th = Math.floor(alt / 1000), hu = Math.round((alt % 1000) / 100);
  return `${th ? digitsWords(th) + ' thousand' : ''}${hu ? ` ${NATO[hu]} hundred` : ''}`.trim();
}

function runCommand(raw) {
  const toks = raw.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return { ok: true };
  let a = S.sel, i = 0;
  const head = toks[0].toUpperCase();
  if (!CMDS[head]) { const m = findAc(toks[0]); if (m) { a = m; S.sel = m; i = 1; } }
  const cmd = (toks[i] || '').toUpperCase();
  if (!CMDS[cmd]) return { unknown: true };
  if (!GLOBAL_CMDS.has(cmd) && !a) return { ok: false, err: 'select an aircraft first' };
  if (!GLOBAL_CMDS.has(cmd) && a.delay > 0) { line('err', a.cs, `unable — not on frequency yet (spawns in ${Math.ceil(a.delay)}s)`); return { ok: false }; }
  const err = CMDS[cmd](a, toks.slice(i + 1));
  if (err) { line('err', a ? a.cs : '', 'unable — ' + err); return { ok: false, err }; }
  return { ok: true };
}

/* ================= OpenRouter phraseology bridge ================= */
const OR = 'https://openrouter.ai/api/v1';
const orHeaders = () => ({
  Authorization: 'Bearer ' + SET.key, 'Content-Type': 'application/json',
  'HTTP-Referer': location.origin, 'X-Title': 'vNAS Ground Trainer',
});
async function orChat(messages, maxTokens = 400, model = SET.model) {
  const r = await fetch(`${OR}/chat/completions`, {
    method: 'POST', headers: orHeaders(),
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: maxTokens }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`HTTP ${r.status} ${t.slice(0, 160)}`); }
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'provider error');
  return j.choices?.[0]?.message?.content ?? '';
}
function parseJSONish(s) {
  s = String(s).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const m = s.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]);
  throw new Error('no JSON in reply');
}
const CMD_REF = `PUSH [taxiway] | TAXI <taxiways...> [HS <pt>] | RWY <runway> TAXI <taxiways...> |
HS <pt> | CROSS | RES | HOLD | BREAK | GIVEWAY <callsign> | LUAW | CTO | EXIT |
CTL (cleared to land) | GA (go around) | CD (contact departure / frequency change) |
FH <hdg> (fly heading) | TL <hdg> | TR <hdg> (turn left/right heading) | CM <alt> (climb/descend and maintain, feet or FL) |
TRACK (start radar track) | DROP | SQ <code> | SN | SS | ID | SAY <gate|type|rwy> | DEL | TAXIALL`;
function syncHint() {
  const h = $('#hint');
  h.textContent = aiEnabled() ? `plain English via ${SET.model}` : 'commands only · add a key in Settings';
  h.classList.toggle('ai', aiEnabled());
  $('#set-btn').classList.toggle('ai-on', aiEnabled());
  $('#tts-btn').setAttribute('aria-pressed', String(!!SET.tts));
}
/* shared prompt for typed and spoken transmissions */
function buildPrompt(audio) {
  const roster = S.ac.filter((a) => a.state !== 'DEP' && a.delay <= 0).slice(0, 60).map((a) =>
    `${a.cs} (${a.ty}) ${a.state}${a.gate ? ` gate ${a.gate}` : ''}${a.rwy ? ` rwy ${a.rwy}` : ''}`).join('; ');
  const gates = Object.keys(GATES);
  const twys = Object.keys(TW);
  /* identifiers with their spoken forms, so "alpha one" resolves to A1 and "one two left" to 12L */
  const twyList = twys.map((t) => (/^[A-Z]{1,2}\d{0,2}$/.test(t) ? `${t} (${spellOut(t)})` : t)).join(', ') || 'none';
  const rwyList = Object.keys(G.rwy).map((r) => `${r} (${spokenRunway(r)})`).join(', ');
  const telephony = Object.entries(TELEPHONY).filter(([k]) => S.ac.some((a) => a.cs.startsWith(k))).map(([k, v]) => `${v} = ${k}`).join(', ');
  const sys = `You are the pilot side of an air traffic control simulator at ${A.name} (${A.id}).
The controller is working the ${modeInfo().label} position. Translate one controller transmission into ATCTrainer commands and produce the pilot's readback.

COMMANDS: ${CMD_REF}

THIS AIRPORT
Runways: ${rwyList}
Taxiways: ${twyList}
Gates and spots (${gates.length}): ${gates.slice(0, 40).join(' ')}${gates.length > 40 ? ' …' : ''}
${A.stars?.dep ? `Departure frequency: ${A.stars.dep.freq} (${A.stars.dep.radio || A.stars.dep.cs})` : ''}

PHRASEOLOGY — how the controller talks, and what it maps to
- Letters are the ICAO alphabet (alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey x-ray yankee zulu). Numbers are spoken digit by digit: "niner" = 9, "tree" = 3, "fife" = 5.
- Runways: "runway one two left" = 12L, "runway three zero right" = 30R, "runway four" = 4. Taxiways: "alpha" = A, "alpha one" = A1, "kilo ten" = K10 — resolve against the taxiway list above; a taxiway name that is a word (ALLEY) is said as a word.
- Callsigns: airline telephony plus the flight number in COMBINED group form, never digit by digit — "Delta ten forty-seven" = DAL1047, "FedEx nineteen ninety-two" = FDX1992, "American eight ninety-four" = AAL894, "SkyWest thirty-five twenty-one" = SKW3521, "Southwest twelve hundred" = SWA1200, "Delta ten" = DAL10. GA aircraft are spelled: "November four two sierra tango" = N42ST, often shortened to the last three ("four two sierra tango" or "two sierra tango"). Always pick the matching callsign from the roster, never invent one.${telephony ? `\n  Telephony on frequency now: ${telephony}.` : ''}
- Ground: "push back approved" → PUSH; "push back approved, tail east onto alpha" → PUSH A; "runway three zero left, taxi via quebec, charlie" → RWY 30L TAXI Q C; "taxi to gate echo one six via bravo" → TAXI B E16; "hold short of runway one two right" as part of a taxi → append HS 12R to that taxi command, on its own → HS 12R; "cross runway one two right" → CROSS; "continue taxi" / "resume" → RES; "hold position" / "stop" → HOLD; "give way to the Delta seven thirty-seven" → GIVEWAY <that callsign>; "expedite" → BREAK; "monitor tower" / "contact ground" → no command, readback only.
- Tower: "line up and wait" → LUAW; "cleared for takeoff" → CTO; "cleared to land" → CTL; "go around" → GA; "fly heading zero niner zero" → FH 090; "turn left/right heading two seven zero" → TL 270 / TR 270; "climb and maintain five thousand" → CM 5000; "climb and maintain flight level two three zero" → CM FL230; "contact departure" → CD; "exit at alpha five" → EXIT A5.
- Transponder: "squawk four five two one" → SQ 4521; "ident" → ID; "squawk standby" → SS; "squawk normal" → SN.
- Several instructions in one transmission are several commands, in the order spoken. A transmission that is only a callsign check-in, an acknowledgement, or addressed to nobody in the roster produces no commands.
${audio ? `
AUDIO: the attached recording is the controller's push-to-talk transmission over a VHF radio — it may be clipped, fast, or noisy. Use the roster and the identifier lists above to resolve anything ambiguous (a taxiway you cannot hear clearly is one that exists here). Do not transcribe what is not there; if nothing usable was said, return no commands and say so in the readback.
` : ''}
READBACK RULES
- "readback": the pilot's readback in standard WRITTEN phraseology with written identifiers, e.g. "Runway 30L, taxi via Q C, hold short 12R, Delta 1047". Read back the instruction, not a commentary. End with the callsign (written form).
- "spoken": the exact words for text-to-speech, every identifier spelled out: runways as digits plus left/right/center ("runway three zero left"), taxiways in the ICAO alphabet ("quebec, charlie"), gates likewise ("echo one six"), headings, squawk codes and beacon codes digit by digit using "niner", altitudes as "five thousand" / "flight level two three zero", frequencies as digits with "point" ("one two four point seven"), the callsign in telephony with the combined flight number ("Delta ten forty-seven", "FedEx nineteen ninety-two" — not "one nine nine two") — never leave a bare abbreviation like "30L" or "Q" in the spoken text.

Reply with ONLY a JSON object:
{${audio ? '"transcript":"<what the controller said, in standard written phraseology with written identifiers, e.g. DAL1047, runway 30L, taxi via Q C, hold short 12R>",\n ' : ''}"callsign":"<exact callsign from the roster, or null>",
 "commands":["<command line>", ...],
 "readback":"<written readback>",
 "spoken":"<spoken readback>"}`;
  const user = `AIRCRAFT ON FREQUENCY: ${roster || 'none'}
CURRENTLY SELECTED: ${S.sel ? S.sel.cs : 'none'}`;
  return { sys, user };
}
/* run a translated transmission: select, execute, read back */
function applyTranslation(out, said) {
  const a = out.callsign ? findAc(out.callsign) : S.sel;
  if (said) line('atc', null, said);
  if (!a) { line('err', '', `no aircraft matched "${out.callsign || '—'}"${out.readback ? ' — ' + out.readback : ''}`); return; }
  S.sel = a;
  let bad = false;
  quiet++;
  try {
    for (const c of out.commands || []) {
      const r = runCommand(`${a.cs} ${c}`);
      if (r.unknown) { line('err', a.cs, `could not run "${c}"`); bad = true; }
      else if (!r.ok) bad = true;
    }
  } finally { quiet--; }
  if (out.readback && !bad) { line('pilot', a.cs, out.readback); speak(a, out.spoken || spokenFallback(out.readback), { raw: true }); }
  syncSel(); renderStrips();
}
async function askAI(text) {
  if (!aiEnabled()) { line('err', '', 'unrecognised command — see Commands, or add an OpenRouter key in Settings for plain English'); return; }
  const pending = line('ai', '', 'translating…');
  try {
    const { sys, user } = buildPrompt(false);
    const out = parseJSONish(await orChat([{ role: 'system', content: sys }, { role: 'user', content: `${user}\n\nCONTROLLER SAID: ${JSON.stringify(text)}` }]));
    pending.remove();
    applyTranslation(out, text);
  } catch (e) {
    pending.remove();
    line('err', '', `could not translate that (${e.message}) — try the command syntax`);
  }
}
async function askAIAudio(wavB64, secs) {
  const pending = line('ai', '', `transcribing ${secs.toFixed(1)}s…`);
  setPtt('busy');
  try {
    const { sys, user } = buildPrompt(true);
    const out = parseJSONish(await orChat([
      { role: 'system', content: sys },
      { role: 'user', content: [{ type: 'text', text: user }, { type: 'input_audio', input_audio: { data: wavB64, format: 'wav' } }] },
    ], 500, SET.audioModel || SET.model));
    pending.remove();
    applyTranslation(out, out.transcript || '(spoken)');
  } catch (e) {
    pending.remove();
    line('err', '', `could not understand that transmission (${e.message})`);
  } finally { setPtt(ptt ? 'tx' : 'idle'); }
}

/* ================= audio: push-to-talk ================= */
let ptt = false, mediaStream = null, recorder = null, chunks = [], recStart = 0, webRec = null;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
function setPtt(state) {
  const b = $('#ptt');
  b.className = 'tbtn ptt' + (state === 'idle' ? '' : ' ' + state);
  b.textContent = { idle: 'PTT', tx: 'TX', busy: '…', listen: 'REC' }[state] || 'PTT';
}
async function pttStart() {
  if (ptt || !G) return;
  ptt = true;
  if (!aiEnabled()) {                       /* keyless: browser speech recognition, words treated as typed */
    if (!SR) { ptt = false; line('err', '', 'no speech recognition in this browser — add an OpenRouter key in Settings for audio'); return; }
    try {
      webRec = new SR(); webRec.lang = 'en-US'; webRec.interimResults = false; webRec.maxAlternatives = 1;
      webRec.onresult = (e) => { const t = e.results[0]?.[0]?.transcript; if (t) submitText(t); };
      webRec.onerror = (e) => {
        if (e.error !== 'aborted' && e.error !== 'no-speech') line('err', '', `speech recognition: ${e.error}`);
        ptt = false; webRec = null; setPtt('idle');
      };
      webRec.onend = () => { if (!ptt) { webRec = null; setPtt('idle'); } };
      webRec.start(); setPtt('listen');
    } catch (e) { ptt = false; line('err', '', `speech recognition unavailable (${e.message})`); }
    return;
  }
  setPtt('tx');
  try { mediaStream = mediaStream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { ptt = false; setPtt('idle'); line('err', '', `microphone unavailable (${e.message})`); return; }
  if (!ptt) return;                          /* released before the mic came up */
  chunks = [];
  recorder = new MediaRecorder(mediaStream);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    const secs = (performance.now() - recStart) / 1000;
    const blob = new Blob(chunks, { type: recorder.mimeType });
    if (secs < 0.4 || !blob.size) { line('sys', '', 'transmission too short'); setPtt('idle'); return; }
    try { askAIAudio(await encodeWav16k(blob), secs); }
    catch (e) { line('err', '', `could not encode audio (${e.message})`); setPtt('idle'); }
  };
  recorder.start(); recStart = performance.now();
}
function pttStop() {
  if (!ptt) return;
  ptt = false;
  if (webRec) { const r = webRec; webRec = null; setPtt('idle'); try { r.stop(); } catch { /* ignore */ } return; }
  if (recorder && recorder.state !== 'inactive') recorder.stop(); else setPtt('idle');
}
/* any browser recording -> 16 kHz mono 16-bit WAV, base64 (what audio models expect) */
async function encodeWav16k(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  const src = await ac.decodeAudioData(await blob.arrayBuffer());
  ac.close?.();
  const rate = 16000, frames = Math.max(1, Math.ceil(src.duration * rate));
  const off = new OfflineAudioContext(1, frames, rate);
  const node = off.createBufferSource(); node.buffer = src; node.connect(off.destination); node.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  const bytes = new Uint8Array(buf); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* ================= audio: pilot voices ================= */
const TELEPHONY = {
  AAL: 'American', DAL: 'Delta', UAL: 'United', SWA: 'Southwest', SKW: 'SkyWest', EDV: 'Endeavor', RPA: 'Brickyard',
  ENY: 'Envoy', JBU: 'JetBlue', SCX: 'Sun Country', ASA: 'Alaska', NKS: 'Spirit', FFT: 'Frontier', FDX: 'FedEx', UPS: 'UPS',
  EJA: 'ExecJet', LXJ: 'Flexjet', JIA: 'Blue Streak', ASH: 'Air Shuttle', QXE: 'Horizon', AWI: 'Wisconsin', GJS: 'Lindbergh',
  PDT: 'Piedmont', CPZ: 'Compass', ACA: 'Air Canada', JZA: 'Jazz', WJA: 'WestJet', BAW: 'Speedbird', DLH: 'Lufthansa',
  AFR: 'Air France', KLM: 'KLM', UAE: 'Emirates', ICE: 'Ice Air', AAY: 'Allegiant', HAL: 'Hawaiian', MXY: 'Breeze',
  VRD: 'Redwood', AMX: 'Aeromexico', VIV: 'Viva', VOI: 'Volaris', CFG: 'Condor', VIR: 'Virgin', ABX: 'Abex', GTI: 'Giant',
  ATN: 'Air Transport', CKS: 'Connie', SWQ: 'Swift', BMJ: 'Bemidji', MTN: 'Mountain', LYM: 'Key Lime', JTL: 'Jet Linx',
};
const NATO = { A: 'alpha', B: 'bravo', C: 'charlie', D: 'delta', E: 'echo', F: 'foxtrot', G: 'golf', H: 'hotel', I: 'india', J: 'juliet',
  K: 'kilo', L: 'lima', M: 'mike', N: 'november', O: 'oscar', P: 'papa', Q: 'quebec', R: 'romeo', S: 'sierra', T: 'tango',
  U: 'uniform', V: 'victor', W: 'whiskey', X: 'x-ray', Y: 'yankee', Z: 'zulu', 0: 'zero', 1: 'one', 2: 'two', 3: 'three',
  4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'niner' };
const spell = (s) => [...s].map((c) => NATO[c] || c).join(' ');
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const numWords = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? '-' + ONES[n % 10] : ''}`);
/* airline flight numbers in group form: 1047 -> "ten forty-seven", 894 -> "eight ninety-four", 1004 -> "ten zero four" */
function groupNumber(d) {
  const pair = (p) => (p === '00' ? 'hundred' : p[0] === '0' ? `zero ${ONES[+p[1]]}` : numWords(+p));
  if (d.length === 4) return `${numWords(+d.slice(0, 2))} ${pair(d.slice(2))}`;
  if (d.length === 3) return `${ONES[+d[0]]} ${pair(d.slice(1))}`;
  return numWords(+d);
}
function spokenCallsign(cs) {
  const m = /^([A-Z]{3})(\d{1,4})([A-Z]{0,2})$/.exec(cs);
  if (m && TELEPHONY[m[1]]) return `${TELEPHONY[m[1]]} ${groupNumber(m[2])}${m[3] ? ' ' + spell(m[3]) : ''}`;
  if (/^N[0-9A-Z]+$/.test(cs)) return spell(cs);
  return m ? `${spell(m[1])} ${spell(m[2])}${m[3] ? ' ' + spell(m[3]) : ''}` : spell(cs);
}
const csHash = (cs) => [...cs].reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 7);

/* ---- browser engine ---- */
let VOICES = [];
function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  VOICES = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
  if ($('#s-engine').value === 'browser') fillVoiceSelect();
}
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.addEventListener('voiceschanged', loadVoices); }
function speakBrowser(cs, text, voiceName = SET.voice) {
  if (!('speechSynthesis' in window)) return;
  const h = csHash(cs);
  const u = new SpeechSynthesisUtterance(text);
  const v = (voiceName && VOICES.find((x) => x.name === voiceName)) || (VOICES.length ? VOICES[h % VOICES.length] : null);
  if (v) u.voice = v;
  u.rate = 1.05 + ((h >> 4) % 3) * 0.06; u.pitch = 0.85 + ((h >> 8) % 6) * 0.06; u.volume = 1;
  speechSynthesis.speak(u);
}

/* ---- OpenRouter engine: POST /audio/speech, decoded and played through a VHF-ish filter ---- */
let TTS_MODELS = null;                    /* id -> { voices: [] | null } */
async function loadTtsModels() {
  if (TTS_MODELS) return TTS_MODELS;
  const j = await getJSON(`${OR}/models?output_modalities=speech`);
  TTS_MODELS = {};
  for (const m of j.data || []) TTS_MODELS[m.id] = { voices: m.supported_voices || null, name: m.name || m.id };
  $('#ttsmodels').innerHTML = Object.keys(TTS_MODELS).sort().map((id) => `<option value="${esc(id)}">`).join('');
  return TTS_MODELS;
}
/* voices that are plainly English, when the provider encodes language in the name */
function englishVoices(list) {
  const en = list.filter((v) => /(^|[-_])(en|gb|us)([-_]|$)|^(af|am|bf|bm)_|^English_/i.test(v));
  return en.length ? en : list;
}
/* no singing, whispering, sulking or Santa on frequency: keep the plain, professional voices */
const VANITY = /whisper|sing|seduc|upset|sad|angry|frustrat|excit|cheer|happy|sarcas|confus|shame|jealous|curious|playful|santa|radiant|magnetic|captivat|compelling|graceful|expressive|narrator|aussie|bloke|girl|boy|kid|child|teen|elf|robot|monster|witch|ghost|pirate|cowboy|fear|scared|cry|laugh|drunk|sleepy|asmr|passionate|warrior|queen|king|prince|anime|comedian|whimsical|lovely|sentimental|stress|bossy|imposing|soft-spoken|storyteller|jovial|partner|strong-willed|debat|kind-hearted|upbeat|^none$/i;
const EMOTION_SUFFIX = /_(neutral|sad|happy|angry|frustrated|excited|confident|cheerful|curious|sarcasm|confused|shameful|jealousy|calm|serious|surprised|disgusted|fearful)$/i;
function professionalVoices(list) {
  const out = list.filter((v) => !VANITY.test(v) && (!EMOTION_SUFFIX.test(v) || /_neutral$/i.test(v)));
  return out.length ? out : list;
}
function pickVoice(cs, model = SET.ttsModel, voice = SET.ttsVoice) {
  if (voice) return voice;
  const list = TTS_MODELS?.[model]?.voices;
  if (!list || !list.length) return undefined;
  const en = professionalVoices(englishVoices(list));
  return en[csHash(cs) % en.length];
}
let actx = null;
function audioCtx() {
  actx = actx || new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}
const TTS_CACHE = new Map();
async function fetchSpeech(text, model, voice) {
  const key = `${model}|${voice || ''}|${text}`;
  if (TTS_CACHE.has(key)) return TTS_CACHE.get(key);
  const p = (async () => {
    const body = { model, input: text, response_format: 'mp3' };
    if (voice) body.voice = voice;
    const r = await fetch(`${OR}/audio/speech`, { method: 'POST', headers: orHeaders(), body: JSON.stringify(body) });
    if (!r.ok) { const t = await r.text().catch(() => ''); let msg = t.slice(0, 160); try { msg = JSON.parse(t).error?.message || msg; } catch { /* keep */ } throw new Error(`HTTP ${r.status} ${msg}`); }
    return audioCtx().decodeAudioData(await r.arrayBuffer());
  })();
  TTS_CACHE.set(key, p);
  p.catch(() => TTS_CACHE.delete(key));
  if (TTS_CACHE.size > 200) TTS_CACHE.delete(TTS_CACHE.keys().next().value);
  return p;
}
let playing = null;
function playBuffer(buf, radio = SET.radio) {
  return new Promise((resolve) => {
    const ac = audioCtx();
    const src = ac.createBufferSource(); src.buffer = buf;
    let node = src;
    if (radio) {
      /* VHF receiver: ~300–3000 Hz passband, a little grit, then squash the dynamics */
      const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 320; hp.Q.value = 0.9;
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000; lp.Q.value = 0.9;
      const shaper = ac.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) { const x = (i / 511.5) - 1; curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2); }
      shaper.curve = curve;
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -28; comp.ratio.value = 8; comp.attack.value = 0.003; comp.release.value = 0.12;
      const gain = ac.createGain(); gain.gain.value = 1.25;
      node.connect(hp); hp.connect(lp); lp.connect(shaper); shaper.connect(comp); comp.connect(gain); node = gain;
    }
    node.connect(ac.destination);
    playing = src;
    src.onended = () => { if (playing === src) playing = null; resolve(); };
    src.start();
  });
}
/* one transmission at a time; fetches run ahead of playback */
const AQ = []; let pumping = false;
let ttsWarned = false;
async function pump() {
  if (pumping) return; pumping = true;
  while (AQ.length) {
    const it = AQ.shift();
    try { await playBuffer(await it.audio, it.radio); }
    catch (e) {
      if (!ttsWarned) { ttsWarned = true; line('err', '', `OpenRouter voice failed (${e.message}) — falling back to the browser voice`); }
      speakBrowser(it.cs, it.text);
    }
  }
  pumping = false;
}
function speakOR(cs, text, model = SET.ttsModel, voice = SET.ttsVoice, radio = SET.radio) {
  if (!TTS_MODELS) loadTtsModels().catch(() => {});
  const v = pickVoice(cs, model, voice);
  AQ.push({ cs, text, radio, audio: fetchSpeech(text, model, v) });
  pump();
}
function stopSpeaking() {
  AQ.length = 0;
  if (playing) { try { playing.stop(); } catch { /* ignore */ } playing = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}
function fillVoiceSelect() {
  const sel = $('#s-voice');
  const engine = $('#s-engine').value;
  if (engine === 'browser') {
    sel.innerHTML = '<option value="">auto — varies per aircraft</option>' +
      VOICES.map((v) => `<option value="${esc(v.name)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
    sel.value = VOICES.some((v) => v.name === SET.voice) ? SET.voice : '';
  } else {
    const model = $('#s-ttsmodel').value.trim();
    const list = TTS_MODELS?.[model]?.voices;
    if (!TTS_MODELS) sel.innerHTML = '<option value="">loading voices…</option>';
    else if (!list || !list.length) sel.innerHTML = '<option value="">provider default (this model lists no voices)</option>';
    else {
      const shown = professionalVoices(list);
      sel.innerHTML = '<option value="">auto — varies per aircraft</option>' + shown.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('') +
        (shown.length < list.length ? `<option value="" disabled>— ${list.length - shown.length} stylised voices hidden —</option>` : '');
    }
    sel.value = list && list.includes(SET.ttsVoice) ? SET.ttsVoice : '';
  }
}

/* raw: a model-written readback already ends the way a pilot would; don't append the callsign */
function speak(a, text, opts = {}) {
  if (!SET.tts) return;
  const utter = opts.raw ? text : `${text}, ${spokenCallsign(a.cs)}`;
  if (SET.ttsEngine === 'openrouter' && SET.key) speakOR(a.cs, utter);
  else speakBrowser(a.cs, utter);
}

/* ================= scenarios ================= */
function loadScenario(sc) {
  CUR_SCEN = sc;
  S.ac = []; S.t = 0; S.sel = null; S.seq = 0; LOG.innerHTML = '';
  let skipped = 0;
  for (const r of sc ? sc.ac : []) {
    const a = Aircraft({
      cs: r.cs, ty: r.ty, dep: r.dep, dst: r.dst, delay: r.d || 0, sq: String(1000 + Math.floor(Math.random() * 6000)), xpdr: 'S',
      rules: r.r || 'I', tyf: r.tyf || null, rte: r.rte || null, alt: r.alt || null, cspd: r.spd || null, rmk: r.rmk || null,
      sid: r.sid || null, star: r.star || null, app: r.app || null,
    });
    const at = String(r.at || '').toUpperCase();
    if (r.k === 'P') {
      const g = GATES[at]; if (!g) { skipped++; continue; }
      a.gate = at; a.pos = g.c.slice(); a.hdg = g.h; a.state = 'PARKED';
    } else if (r.k === 'R') {
      const info = G.rwy[at]; if (!info) { skipped++; continue; }
      const hold = holdNodeFor(at);
      const thr = NODES[info.chain[0]], hp = NODES[hold];
      const back = hold === info.chain[0] ? (bearing(NODES[info.chain[0]], NODES[info.chain[1]]) + 180) % 360 : bearing(thr, hp);
      const q = r.q || 0;
      a.pos = q ? movePt(hp, back, q * 260) : hp.slice();
      a.hdg = (back + 180) % 360; a.rwy = at; a.state = 'SHORT';
    } else if (r.k === 'F') {
      const info = G.rwy[at]; if (!info) { skipped++; continue; }
      placeOnFinal(a, at, r.nm || 5);
      a.xpdr = 'N'; a.tracked = true; a.ctl = SET.mode !== 'tower';
      if (SET.mode === 'tower') setTimeout(() => { if (S.ac.includes(a) && a.state === 'FINAL') checkIn(a, r.nm || 5); }, 400 + S.ac.length * 60);
    } else { skipped++; continue; }
    S.ac.push(a);
  }
  if (sc) {
    line('sys', '', `${sc.name} — ${S.ac.length} surface aircraft${sc.air ? `, ${sc.air} airborne not loaded` : ''}${skipped ? `, ${skipped} unplaced` : ''}.${sc.stu ? ` Student position ${sc.stu}.` : ''}`);
  } else line('sys', '', `${A.name} — empty field. Switch on Arrivals, or pick a scenario.`);
  const rw = Object.keys(G.rwy)[0] || '—', tw = Object.keys(TW).slice(0, 2).join(' ');
  line('sys', '', Object.keys(TW).length
    ? `${modeInfo().label} position. Select an aircraft, then try: ${modeInfo().tips(rw, tw)}`
    : `This training map has runways only — no taxiways, so PUSH and TAXI are unavailable here. Try: LUAW · CTO · Arrivals.`);
  nextArr = 0;
  fit(); renderStrips(); syncChrome(); syncSel();
}
function placeOnFinal(a, rw, nm) {
  const info = G.rwy[rw];
  const thr = NODES[info.chain[0]];
  const crs = bearing(NODES[info.chain[0]], NODES[info.chain[1]]);
  a.pos = movePt(thr, (crs + 180) % 360, nm * 6076); a.hdg = crs; a.spd = 140; a.alt = nm * 318;
  a.state = 'FINAL'; a.rwy = rw; a.landed = false;
  a._origin = a.pos.slice(); a.path = info.chain.slice(); a.leg = 0; a.frac = 0; a.holdLeg = null;
}

/* "Minneapolis Tower, Delta ten forty-seven, six mile final, runway three zero right" */
function checkIn(a, nm) {
  const who = A.stars?.twr?.radio || `${A.name.replace(/\s+(ATCT|Tower).*$/i, '')} Tower`;
  say(a, `${who}, {c:${a.cs}}, ${numWords(Math.round(nm))} mile final, runway {r:${a.rwy}}`, 'pilot');
}

/* arrivals from the airport's own weighted fleet table */
const FALLBACK_FLEET = [{ a: 'N', w: 1, t: ['C172', 'BE36', 'C56X', 'PC12'] }];
function pickFleet() {
  const F = A.fleet.length ? A.fleet : FALLBACK_FLEET;
  const W = F.reduce((s, f) => s + f.w, 0);
  let r = Math.random() * W;
  for (const f of F) { r -= f.w; if (r <= 0) return f; }
  return F[0];
}
let nextArr = 0;
function maybeArrival() {
  if (!S.arrivals || S.t < nextArr) return;
  nextArr = S.t + 70 + Math.random() * 40;
  const rws = (CUR_SCEN?.gen || []).filter((r) => G.rwy[r]);
  const landing = rws.length ? rws : Object.keys(G.rwy);
  if (!landing.length) return;
  const rw = landing[Math.floor(Math.random() * landing.length)];
  const f = pickFleet();
  const a = Aircraft({
    cs: f.a + (100 + Math.floor(Math.random() * 899)), ty: f.t[Math.floor(Math.random() * f.t.length)] || 'C172',
    dep: null, dst: A.id, xpdr: 'N', sq: String(1000 + Math.floor(Math.random() * 6000)),
  });
  const tower = SET.mode === 'tower';
  placeOnFinal(a, rw, tower ? 6 : 3);
  a.tracked = true; a.ctl = !tower;                       /* local has to clear them to land */
  if (GATE_NAMES.length) a.destGate = GATE_NAMES[Math.floor(Math.random() * GATE_NAMES.length)];
  S.ac.push(a);
  line('sys', '', `${a.cs} ${a.ty} ${tower ? '6 mile final' : 'on final'} runway ${rw}${a.destGate ? `, parking ${a.destGate}` : ''}`);
  if (tower) checkIn(a, 6);
}

/* ================= rendering ================= */
const scope = $('#scope');
const svg = document.createElementNS(NS, 'svg');
svg.setAttribute('xmlns', NS);
scope.insertBefore(svg, scope.firstChild);
const gPave = document.createElementNS(NS, 'g');
const gStatic = document.createElementNS(NS, 'g');
const gDyn = document.createElementNS(NS, 'g');
svg.appendChild(gPave); svg.appendChild(gStatic); svg.appendChild(gDyn);

let view = { x: 0, y: 0, w: 1000, h: 1000 };
function applyView() {
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
}
function fit() {
  const pad = WORLD_W * 0.04;
  view = { x: -pad, y: -pad, w: WORLD_W + pad * 2, h: WORLD_H + pad * 2 };
  applyView();
}
function zoomAt(cx, cy, k) {
  const r = svg.getBoundingClientRect();
  const fx = (cx - r.left) / r.width, fy = (cy - r.top) / r.height;
  const wx = view.x + view.w * fx, wy = view.y + view.h * fy;
  const nw = Math.max(WORLD_W * 0.03, Math.min(WORLD_W * 1.6, view.w * k));
  const nh = nw * (view.h / view.w);
  view = { x: wx - nw * fx, y: wy - nh * fy, w: nw, h: nh };
  applyView();
}
const svgEl = (t, at, parent) => { const e = document.createElementNS(NS, t); for (const k in at) e.setAttribute(k, at[k]); parent.appendChild(e); return e; };
const ringPath = (ring) => ring.map((c, i) => (i ? 'L' : 'M') + P(c).map((v) => v.toFixed(0)).join(' ')).join('') + 'Z';

function buildStatic() {
  gStatic.innerHTML = '';
  /* centreline network */
  for (const nm in TW) {
    const seen = new Set();
    for (const n of TW[nm]) for (const [m, , en] of ADJ[n] || []) {
      if (en !== nm) continue;
      const key = Math.min(n, m) + '-' + Math.max(n, m);
      if (seen.has(key)) continue; seen.add(key);
      const a = P(NODES[n]), b = P(NODES[m]);
      svgEl('line', { x1: a[0].toFixed(0), y1: a[1].toFixed(0), x2: b[0].toFixed(0), y2: b[1].toFixed(0), 'stroke-width': 2.4 * U, opacity: .5 }, gStatic).style.stroke = 'var(--net)';
    }
  }
  /* runway centrelines + designators (one label per end) */
  for (const [des, info] of Object.entries(G.rwy)) {
    const c = info.chain;
    svgEl('polyline', { points: c.map((n) => P(NODES[n]).map((v) => v.toFixed(0)).join(',')).join(' '), fill: 'none', 'stroke-width': 3 * U, opacity: .55, 'stroke-linecap': 'round' }, gStatic).style.stroke = 'var(--pave-rwy)';
    const t = P(NODES[c[0]]);
    const lbl = svgEl('text', { x: t[0], y: t[1], 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-family': 'IBM Plex Mono, monospace', 'font-size': 22 * U, 'font-weight': 600, opacity: .85 }, gStatic);
    lbl.style.fill = 'var(--ink-3)'; lbl.textContent = des;
  }
  /* gates and spots */
  for (const g of Object.values(GATES)) {
    const c = P(g.c);
    svgEl('circle', { cx: c[0].toFixed(0), cy: c[1].toFixed(0), r: 3.2 * U, opacity: g.spot ? .3 : .45 }, gStatic).style.fill = g.spot ? 'var(--accent)' : 'var(--net)';
  }
}
/* ASDE-X pavement (or the tower-cab map as a fallback), fetched live from vNAS */
let paveToken = 0;
async function loadPavement(doc) {
  const token = ++paveToken;
  gPave.innerHTML = '';
  const id = doc.asdex || doc.twrmap; if (!id) return;
  try {
    const gj = await getJSON(`${FILES}/VideoMaps/${doc.artcc}/${id}.geojson`, { mode: 'cors' });
    if (token !== paveToken) return;
    const asdex = !!doc.asdex;
    const cats = { apron: 'var(--pave-str)', structure: 'var(--pave-str)', taxiway: 'var(--pave-txi)', runway: 'var(--pave-rwy)', hold: 'var(--pave-txi)' };
    const order = asdex ? ['apron', 'structure', 'taxiway', 'runway'] : [null];
    const feats = gj.features || [];
    const frag = document.createDocumentFragment();
    for (const cat of order) {
      for (const f of feats) {
        const p = f.properties || {};
        if (asdex && (p.asdex || 'other') !== cat) continue;
        const g = f.geometry; if (!g) continue;
        if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
          const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
          const d = polys.map((rings) => rings.map(ringPath).join('')).join('');
          const el = svgEl('path', { d, stroke: 'none' }, frag);
          el.style.fill = asdex ? (cats[cat] || 'var(--pave-str)') : (p.color || 'var(--pave-str)');
          if (!asdex) el.style.opacity = .35;
        } else if (!asdex && (g.type === 'LineString' || g.type === 'MultiLineString')) {
          const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
          const d = lines.map((l) => l.map((c, i) => (i ? 'L' : 'M') + P(c).map((v) => v.toFixed(0)).join(' ')).join('')).join('');
          const el = svgEl('path', { d, fill: 'none', 'stroke-width': Math.max(1, (p.thickness || 1)) * U * 1.2 }, frag);
          el.style.stroke = p.color || 'var(--net)'; el.style.opacity = .35;
        }
      }
    }
    gPave.appendChild(frag);
  } catch (e) { line('sys', '', `no pavement map (${e.message})`); }
}

const STATE_COLOR = {
  PARKED: 'var(--ink-3)', PUSH: 'var(--violet)', PUSHED: 'var(--violet)', TAXI: 'var(--green)', SHORT: 'var(--amber)', HOLD: 'var(--red)',
  LUAW: 'var(--cyan)', TKOF: 'var(--cyan)', FINAL: 'var(--cyan)', ROLLOUT: 'var(--cyan)', AIRB: 'var(--cyan)', DEP: 'var(--ink-3)',
};
const STATE_TEXT = { PARKED: 'gate', PUSH: 'push', PUSHED: 'ready', TAXI: 'taxi', SHORT: 'short', HOLD: 'hold', LUAW: 'luaw', TKOF: 'roll', FINAL: 'final', ROLLOUT: 'rollout', AIRB: 'airborne', DEP: 'gone' };
function render() {
  if (!G) return;
  const showTags = view.w < WORLD_W * 0.62;
  const s = view.w / WORLD_W;
  const sz = 7.5 * U * Math.max(0.55, Math.min(1.6, s));
  let out = '';
  for (const a of S.ac) {
    if (a.state === 'DEP' || a.delay > 0) continue;   /* not spawned yet, or gone */
    const c = P(a.pos);
    const col = STATE_COLOR[a.state] || 'var(--ink)';
    const selected = S.sel === a;
    if (a.hist.length > 1 && a.spd > 1) {
      for (let i = 0; i < a.hist.length - 1; i++) {
        const h = P(a.hist[i]);
        out += `<circle cx="${h[0].toFixed(0)}" cy="${h[1].toFixed(0)}" r="${(sz * 0.22).toFixed(1)}" fill="${col}" opacity="${(0.1 + 0.06 * i).toFixed(2)}"/>`;
      }
    }
    if (selected) out += `<circle cx="${c[0].toFixed(0)}" cy="${c[1].toFixed(0)}" r="${(sz * 2.1).toFixed(1)}" fill="none" stroke="var(--cyan)" stroke-width="${(sz * 0.22).toFixed(1)}" opacity=".85"/>`;
    out += `<g transform="translate(${c[0].toFixed(0)},${c[1].toFixed(0)}) rotate(${a.hdg.toFixed(0)})">` +
      `<polygon points="0,${-sz} ${(sz * .74).toFixed(1)},${(sz * .82).toFixed(1)} 0,${(sz * .46).toFixed(1)} ${(-sz * .74).toFixed(1)},${(sz * .82).toFixed(1)}" fill="${col}" stroke="var(--bg)" stroke-width="${(sz * 0.13).toFixed(2)}"/></g>`;
    if (showTags || selected || a.state !== 'PARKED') {
      const fs = Math.max(8 * U, 11 * U * Math.max(0.6, Math.min(1.5, s)));
      const tx = c[0] + sz * 1.9, ty = c[1] - sz * 0.5;
      const l2 = a.state === 'PARKED' ? `${a.ty} ${a.gate || ''}` : a.rwy ? `${a.ty} ${a.rwy}` : `${a.ty}${a.destGate ? ' ' + a.destGate : ''}`;
      out += `<text x="${tx.toFixed(0)}" y="${ty.toFixed(0)}" font-family="IBM Plex Mono, monospace" font-size="${fs.toFixed(1)}" font-weight="600" fill="${selected ? 'var(--cyan)' : 'var(--ink)'}">${esc(a.cs)}</text>` +
        `<text x="${tx.toFixed(0)}" y="${(ty + fs * 1.12).toFixed(0)}" font-family="IBM Plex Mono, monospace" font-size="${(fs * 0.86).toFixed(1)}" fill="var(--ink-3)">${esc(l2)}</text>`;
    }
  }
  gDyn.innerHTML = out;
  const mm = String(Math.floor(S.t / 60)).padStart(2, '0'), ss = String(Math.floor(S.t % 60)).padStart(2, '0');
  $('#clk').textContent = `${mm}:${ss}`;
  const pending = S.ac.filter((a) => a.delay > 0).length;
  const active = S.ac.filter((a) => a.state !== 'DEP' && a.delay <= 0).length;
  $('#hud').innerHTML = `${esc(A.id)} · ${active} aircraft · ${S.ac.filter((a) => a.delay <= 0 && (a.state === 'TAXI' || a.state === 'PUSH')).length} moving${pending ? ` · ${pending} pending` : ''}<br>scroll to zoom · drag to pan`;
}
function renderStrips() {
  const rank = (a) => a.delay > 0 ? 8 : ({ AIRB: 0, TKOF: 0, LUAW: 1, SHORT: 2, TAXI: 3, PUSH: 3, PUSHED: 4, HOLD: 2, FINAL: 0, ROLLOUT: 1, PARKED: 6 })[a.state] ?? 7;
  const list = S.ac.filter((a) => a.state !== 'DEP').sort((a, b) => rank(a) - rank(b) || a.cs.localeCompare(b.cs));
  const pend = list.filter((a) => a.delay > 0).length;
  $('#cnt').textContent = `${list.length - pend} on frequency${pend ? ` · ${pend} pending` : ''}`;
  $('#strips').innerHTML = list.map((a) => {
    const pending = a.delay > 0;
    const col = pending ? 'var(--ink-3)' : (STATE_COLOR[a.state] || 'var(--ink)');
    /* the departure procedure leads the second line: it is what ground needs at a glance */
    const proc = a.sid ? `<b class="sid">${esc(a.sid)}</b>`
      : a.star && !a.dep?.endsWith(A.id) ? `<b class="sid star">${esc(a.star)}</b>`
      : a.rules === 'V' ? `<b class="sid vfr">VFR</b>`
      : a.rte ? `<b class="sid none">no SID</b>` : '';
    const selected = S.sel === a;
    return `<div class="strip" data-cs="${esc(a.cs)}" aria-selected="${selected}" role="button" tabindex="0"${pending ? ' style="opacity:.55"' : ''}>
      <span class="cs">${esc(a.cs)}</span>
      <span class="st" style="color:${col}">${pending ? 'pending' : (STATE_TEXT[a.state] || a.state)}</span>
      <span class="sub">${proc}<b>${esc(a.ty)}</b>${a.gate ? `<b>${esc(a.gate)}</b>` : ''}${a.rwy ? `<b>rwy ${esc(a.rwy)}</b>` : ''}${a.state === 'AIRB' || a.state === 'FINAL' ? `<b>${Math.round(a.alt / 100) * 100} ft${a.state === 'AIRB' && a.tgtAlt !== a.alt ? ` ↑${a.tgtAlt}` : ''}</b>` : ''}${a.state === 'FINAL' && !a.ctl && SET.mode === 'tower' ? `<b style="color:var(--amber)">no CTL</b>` : ''}${a.handoff ? `<b style="color:var(--accent)">H/O</b>` : a.radar && !a.tracked ? `<b>untracked</b>` : ''}${a.dst ? `<span>→ ${esc(a.dst)}</span>` : ''}${a.delay > 0 ? `<b>+${Math.ceil(a.delay)}s</b>` : ''}${a.blockedBy ? `<b>behind ${esc(a.blockedBy)}</b>` : ''}</span>
      ${selected ? flightPlanHTML(a) : ''}
    </div>`;
  }).join('');
}
function flightPlanHTML(a) {
  if (!a.rte && !a.alt && !a.rmk && !a.dep) return `<div class="fp"><span class="k">no flight plan</span></div>`;
  const alt = a.alt ? (a.alt >= 18000 ? `FL${Math.round(a.alt / 100)}` : `${a.alt} ft`) : null;
  const head = [
    a.rules === 'V' ? 'VFR' : 'IFR', a.tyf || a.ty,
    `${a.dep || '—'} → ${a.dst || '—'}`, alt, a.cspd ? `${a.cspd} kt` : null,
  ].filter(Boolean).map(esc).join(' · ');
  const tags = [a.sid ? `SID ${a.sid}` : null, a.star ? `STAR ${a.star}` : null, a.app ? `APP ${a.app}` : null].filter(Boolean).map(esc).join(' · ');
  return `<div class="fp">
    <div>${head}</div>
    ${tags ? `<div class="tags">${tags}</div>` : ''}
    ${a.rte ? `<div class="rte">${esc(a.rte)}</div>` : '<div class="k">no route</div>'}
    ${a.rmk ? `<div class="k">rmk ${esc(a.rmk)}</div>` : ''}
    <div class="k">squawk ${esc(a.sq)}</div>
  </div>`;
}
function selectAc(a) { S.sel = a; syncSel(); renderStrips(); renderStars(); }

/* ================= STARS — the tower's radar display ================= */
const starsEl = $('#stars');
const ssvg = document.createElementNS(NS, 'svg');
ssvg.setAttribute('xmlns', NS);
starsEl.insertBefore(ssvg, starsEl.firstChild);
const sMaps = svgEl('g', {}, ssvg), sRings = svgEl('g', {}, ssvg), sTargets = svgEl('g', {}, ssvg);
let RC = null;                                  /* radar centre [lon, lat] */
let NM_LON = 60, NM_LAT = 60;
const PS = (c) => [(c[0] - RC[0]) * NM_LON, (RC[1] - c[1]) * NM_LAT];   /* lon/lat -> nm east, nm south */
let sview = { x: -15, y: -15, w: 30, h: 30 };
const STARS_SEL = new Set();                    /* video map ids on the display */
let starsToken = 0;
function sApply() {
  ssvg.setAttribute('viewBox', `${sview.x} ${sview.y} ${sview.w} ${sview.h}`);
  ssvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  sHud(); renderStars();
}
function sRange(r) { sview = { x: -r, y: -r, w: 2 * r, h: 2 * r }; sApply(); }
function sZoomAt(cx, cy, k) {
  const r = ssvg.getBoundingClientRect();
  const fx = (cx - r.left) / r.width, fy = (cy - r.top) / r.height;
  const wx = sview.x + sview.w * fx, wy = sview.y + sview.h * fy;
  const nw = Math.max(6, Math.min(160, sview.w * k)), nh = nw * (sview.h / sview.w);
  sview = { x: wx - nw * fx, y: wy - nh * fy, w: nw, h: nh };
  sApply();
}
function sHud() {
  if (!A) return;
  const st = A.stars;
  $('#shud').innerHTML = `${st ? `${esc(st.host)} STARS${st.tcp ? ' · TCP ' + esc(st.tcp) : ''}` : 'no STARS configuration for this airport'} · ${(sview.w / 2).toFixed(0)} nm` +
    `<br>${st?.dep ? `departure ${esc(st.dep.radio || st.dep.cs)} ${esc(st.dep.freq || '')}` : 'no departure position found'} · targets ${S.ac.filter((a) => a.radar).length}`;
}
function starsInit(doc) {
  const st = doc.stars;
  RC = st?.center || doc.tower || [(G.bounds.lon0 + G.bounds.lon1) / 2, (G.bounds.lat0 + G.bounds.lat1) / 2];
  NM_LAT = 60; NM_LON = 60 * Math.cos(RC[1] * Math.PI / 180);
  sMaps.innerHTML = ''; sTargets.innerHTML = ''; sRings.innerHTML = '';
  for (let r = 5; r <= 60; r += 5) {
    svgEl('circle', { cx: 0, cy: 0, r, fill: 'none', 'stroke-width': r % 10 ? 0.6 : 1, 'vector-effect': 'non-scaling-stroke', opacity: r % 10 ? .35 : .6 }, sRings).style.stroke = 'var(--rule-2)';
  }
  /* the field's runways, from the training map, so the picture is anchored even with no maps loaded */
  for (const info of Object.values(G.rwy)) {
    svgEl('polyline', { points: info.chain.map((n) => PS(NODES[n]).map((v) => v.toFixed(4)).join(',')).join(' '), fill: 'none', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', opacity: .8 }, sRings).style.stroke = 'var(--ink-3)';
  }
  STARS_SEL.clear();
  if (st) {
    st.maps.filter((m) => m.av).forEach((m) => STARS_SEL.add(m.id));
    st.def.slice(0, 4).forEach((id) => STARS_SEL.add(id));
  }
  buildMapList(); loadStarsMaps();
  sRange(15);
}
async function loadStarsMaps() {
  const token = ++starsToken;
  sMaps.innerHTML = '';
  if (!A?.stars) return;
  for (const id of STARS_SEL) showStarsMap(id, token);
}
function showStarsMap(id, token = starsToken) {
  const m = A?.stars?.maps.find((x) => x.id === id); if (!m) return;
  getJSON(`${FILES}/VideoMaps/${A.artcc}/${id}.geojson`, { mode: 'cors' }).then((gj) => {
    if (token !== starsToken || !STARS_SEL.has(id) || sMaps.querySelector(`[data-id="${id}"]`)) return;
    let d = '';
    for (const f of gj.features || []) {
      const g = f.geometry; if (!g) continue;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates
        : g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : [];
      for (const l of lines) d += l.map((c, i) => (i ? 'L' : 'M') + PS(c).map((v) => v.toFixed(4)).join(' ')).join('');
    }
    if (!d) return;
    const p = svgEl('path', { d, fill: 'none', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', 'data-id': id, opacity: m.b === 'A' ? .85 : .5 }, sMaps);
    p.style.stroke = 'var(--map)';
  }).catch((e) => line('sys', '', `map ${m.sn || m.n}: ${e.message}`));
}
function buildMapList() {
  const box = $('#smaps');
  if (!A?.stars) { box.innerHTML = '<div class="grp">no STARS maps</div>'; return; }
  const st = A.stars;
  const row = (m, dcb) => `<label class="${dcb ? 'dcb' : ''}"><input type="checkbox" data-id="${esc(m.id)}"${STARS_SEL.has(m.id) ? ' checked' : ''}><b>${esc(String(m.sid ?? ''))}</b> ${esc(m.sn || m.n)}${m.av ? ' <i>always</i>' : ''}</label>`;
  const inDef = new Set(st.def);
  const def = st.def.map((id) => st.maps.find((m) => m.id === id)).filter(Boolean);
  const rest = st.maps.filter((m) => !inDef.has(m.id) && !m.tdm);
  box.innerHTML = `<div class="grp">${esc(st.host)} · tower DCB${st.tcp ? ' (' + esc(st.tcp) + ')' : ''}</div>` + def.map((m) => row(m, true)).join('') +
    (rest.length ? `<div class="grp">other maps (${rest.length})</div>` + rest.map((m) => row(m, false)).join('') : '');
}
/* one radar return per sim second for anything airborne or on the runway */
function radarTick() {
  for (const a of S.ac) {
    const vis = a.delay <= 0 && (a.state === 'AIRB' || a.state === 'FINAL' || a.state === 'ROLLOUT' || (a.state === 'TKOF' && a.spd > 40));
    if (!vis) { a.radar = null; continue; }
    const hist = a.radar ? [...a.radar.hist, a.radar.pos] : [];
    a.radar = { pos: a.pos.slice(), alt: a.alt || 0, spd: a.spd, hist: hist.slice(-5) };
  }
  renderStars();
}
function renderStars() {
  if (!RC || starsEl.offsetParent === null) return;
  const px = ssvg.getBoundingClientRect().width / sview.w || 20;   /* px per nm */
  const fs = 11 / px, sz = 4 / px;
  let out = '';
  for (const a of S.ac) {
    const r = a.radar; if (!r) continue;
    const [x, y] = PS(r.pos);
    const col = a.handoff ? 'var(--accent)' : a.tracked ? 'var(--green)' : 'var(--ink-2)';
    const sel = S.sel === a;
    r.hist.forEach((h, i) => { const [hx, hy] = PS(h); out += `<circle cx="${hx.toFixed(3)}" cy="${hy.toFixed(3)}" r="${(sz * 0.35).toFixed(3)}" fill="${col}" opacity="${(0.15 + 0.12 * i).toFixed(2)}"/>`; });
    if (sel) out += `<circle cx="${x.toFixed(3)}" cy="${y.toFixed(3)}" r="${(sz * 2.4).toFixed(3)}" fill="none" stroke="var(--cyan)" stroke-width="${(sz * 0.25).toFixed(3)}" opacity=".9"/>`;
    out += `<rect x="${(x - sz).toFixed(3)}" y="${(y - sz).toFixed(3)}" width="${(2 * sz).toFixed(3)}" height="${(2 * sz).toFixed(3)}" transform="rotate(45 ${x.toFixed(3)} ${y.toFixed(3)})" fill="${a.tracked ? col : 'none'}" stroke="${col}" stroke-width="${(sz * 0.3).toFixed(3)}"/>`;
    const lx = x + sz * 3.2, ly = y - sz * 3.2;
    out += `<line x1="${(x + sz).toFixed(3)}" y1="${(y - sz).toFixed(3)}" x2="${lx.toFixed(3)}" y2="${ly.toFixed(3)}" stroke="${col}" stroke-width="${(sz * 0.2).toFixed(3)}" opacity=".8"/>`;
    const alt3 = String(Math.max(0, Math.round(r.alt / 100))).padStart(3, '0');
    const spd2 = String(Math.round(r.spd / 10)).padStart(2, '0');
    const lines = a.tracked
      ? [`${a.handoff ? 'H/' : ''}${a.cs}`, `${alt3} ${spd2}`, a.sid ? a.sid.slice(0, 3) : a.state === 'FINAL' || a.goaround ? (a.rwy || '') : (a.ty || '')]
      : [a.sq, alt3];
    lines.forEach((t, i) => {
      out += `<text x="${(lx + sz * 0.4).toFixed(3)}" y="${(ly + fs * (i + 0.85)).toFixed(3)}" font-family="IBM Plex Mono, monospace" font-size="${fs.toFixed(3)}" font-weight="${i === 0 && a.tracked ? 600 : 400}" fill="${sel ? 'var(--cyan)' : col}">${esc(t)}</text>`;
    });
  }
  sTargets.innerHTML = out;
  sHud();
}
function syncSel() { const el = $('#sel'); el.textContent = S.sel ? S.sel.cs : 'no target'; el.classList.toggle('none', !S.sel); }
function setRunning(v) { S.running = v; const b = $('#play'); b.setAttribute('aria-pressed', v); b.textContent = v ? 'Running' : 'Paused'; }
function syncChrome() { $('#rate').textContent = S.rate + '×'; syncSel(); }

/* ================= loop ================= */
const STEP = 0.1;                         /* fixed physics step, sim seconds */
let lastTick = performance.now();
function physics() {
  /* wall-clock driven so a throttled background tab catches up instead of slowing down */
  const now = performance.now();
  const n = Math.min(40, Math.floor((now - lastTick) / (STEP * 1000)));
  if (n <= 0) return;
  lastTick += n * STEP * 1000;
  if (!S.running || !G) return;
  for (let i = 0; i < n * S.rate; i++) {
    S.t += STEP; S.tick++;
    for (const a of S.ac.slice()) step(a, STEP);      /* copy: a step may remove an aircraft */
    maybeArrival();
    if (S.tick % 10 === 0) radarTick();               /* once a sim second, like a sweep */
  }
  renderStrips();
}
setInterval(physics, STEP * 1000);
window.__vgt = { S, get G() { return G; }, get A() { return A; }, runCommand, applyTranslation, spokenCallsign, encodeWav16k, pttStart, pttStop, SET,
  loadTtsModels, pickVoice, englishVoices, fetchSpeech, playBuffer, speakOR, stopSpeaking, get queue() { return AQ.length; },
  spoken, plain, spokenFallback, buildPrompt };
(function frame() { render(); requestAnimationFrame(frame); })();

/* ================= airport activation ================= */
function overlay(msg, err) {
  const o = $('#overlay');
  if (!msg) { o.hidden = true; return; }
  o.hidden = false; o.classList.toggle('err', !!err); o.innerHTML = `<div>${msg}</div>`;
}
function activateAirport(doc) {
  A = doc; G = buildGraph(doc.map);
  NODES = G.nodes; ADJ = G.adj; TW = G.tw; RWSET = G.rwset; GATES = G.park;
  GATE_NAMES = Object.keys(GATES).filter((k) => !GATES[k].spot);
  ftBetween = G.ft; bearing = G.bearing; movePt = G.movePt;
  NODE_TW = {};
  for (const nm in TW) TW[nm].forEach((n) => { (NODE_TW[n] = NODE_TW[n] || new Set()).add(nm); });
  const B = G.bounds;
  WORLD_W = Math.max(1, (B.lon1 - B.lon0) * G.FT_LON); WORLD_H = Math.max(1, (B.lat1 - B.lat0) * G.FT_LAT);
  U = WORLD_W / 1000;
  P = (c) => [(c[0] - B.lon0) * G.FT_LON, (B.lat1 - c[1]) * G.FT_LAT];
  S.ac = []; S.arrivals = false; $('#arr').setAttribute('aria-pressed', 'false');
  buildStatic(); loadPavement(doc); starsInit(doc);
  const sel = $('#scen');
  sel.innerHTML = `<option value="">— empty field —</option>` +
    doc.scen.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}${s.ac ? ` — ${s.ac.length}` : ''}</option>`).join('');
  sel.disabled = false;
  document.title = `${doc.id} · vNAS ${modeInfo().label} Trainer`;
  fit();
}
async function selectScenario(id, pushHash = true) {
  const s = A.scen.find((x) => x.id === id) || null;
  $('#scen').value = s ? s.id : '';
  if (s && s.lazy) {
    overlay('loading scenario…');
    try { await resolveScenario(A, s); } catch (e) { overlay(`could not load scenario: ${esc(e.message)}`, true); return; }
    overlay(null);
    const opt = $('#scen').querySelector(`option[value="${CSS.escape(s.id)}"]`);
    if (opt) opt.textContent = `${s.name} — ${s.ac.length}`;
  }
  loadScenario(s);
  if (pushHash) history.replaceState(null, '', `#${A.id}${s ? '/' + s.id : ''}`);
}
let loadToken = 0;
async function selectAirport(id, scenId) {
  const artcc = INDEX.artccs.find((a) => a.airports.some((p) => p.id === id));
  if (!artcc) { overlay(`unknown airport ${esc(id)}`, true); return; }
  $('#artcc').value = artcc.id; fillAirports(artcc.id); $('#apt').value = id;
  const token = ++loadToken;
  overlay(`loading ${esc(id)}…`);
  $('#scen').disabled = true;
  try {
    const doc = await loadAirport(id, artcc.id);
    if (token !== loadToken) return;
    activateAirport(doc);
    overlay(null);
    const first = scenId && doc.scen.find((s) => s.id === scenId) ? scenId : (doc.scen[0]?.id || '');
    await selectScenario(first);
  } catch (e) {
    if (token !== loadToken) return;
    overlay(`could not load ${esc(id)}: ${esc(e.message)}`, true);
  }
}
function fillAirports(artccId) {
  const a = INDEX.artccs.find((x) => x.id === artccId);
  $('#apt').innerHTML = (a?.airports || []).map((p) =>
    `<option value="${esc(p.id)}">${esc(p.id)} — ${esc(p.name)}${p.n ? ` (${p.n})` : ''}</option>`).join('');
}
function parseHash() {
  const m = location.hash.replace(/^#/, '').split('/');
  return { apt: (m[0] || '').toUpperCase() || null, scen: m[1] || null };
}
async function boot() {
  overlay(live() ? 'loading live from vNAS via proxy…' : 'loading catalog…');
  try { INDEX = await loadIndex(); }
  catch (e) {
    overlay(live()
      ? `could not reach vNAS through the proxy: ${esc(e.message)}<br><br>check the proxy URL in Settings, or clear it to use the catalog`
      : `no catalog found (${esc(e.message)})<br><br>run <code>node build-catalog.mjs</code> before serving this folder, or set a vNAS proxy in Settings`, true);
    $('#artcc').innerHTML = ''; $('#apt').innerHTML = ''; $('#scen').innerHTML = '';
    return;
  }
  $('#artcc').innerHTML = INDEX.artccs.map((a) => `<option value="${esc(a.id)}">${esc(a.id)} — ${esc(a.name)}</option>`).join('');
  const h = parseHash();
  let apt = h.apt && INDEX.artccs.some((a) => a.airports.some((p) => p.id === h.apt)) ? h.apt : null;
  if (!apt) {
    let best = null;
    for (const a of INDEX.artccs) for (const p of a.airports) if (!best || p.n > best.n) best = p;
    apt = best?.id;
  }
  if (!apt) { overlay('the catalog has no airports', true); return; }
  await selectAirport(apt, h.scen);
}

/* ================= input ================= */
{
  $('#mode').addEventListener('change', (e) => {
    SET.mode = e.target.value; saveSettings(); applyMode();
    if (G) {
      const rw = Object.keys(G.rwy)[0] || '—', tw = Object.keys(TW).slice(0, 2).join(' ');
      line('sys', '', `${modeInfo().label} position — try: ${modeInfo().tips(rw, tw)}`);
    }
    e.target.blur();
  });
  $('#artcc').addEventListener('change', (e) => { fillAirports(e.target.value); const first = $('#apt').value; if (first) selectAirport(first); });
  $('#apt').addEventListener('change', (e) => selectAirport(e.target.value));
  $('#scen').addEventListener('change', (e) => selectScenario(e.target.value));
  addEventListener('hashchange', () => { const h = parseHash(); if (!h.apt) return; if (A && h.apt === A.id) selectScenario(h.scen, false); else selectAirport(h.apt, h.scen); });

  $('#play').addEventListener('click', () => setRunning(!S.running));
  $('#rate').addEventListener('click', () => { S.rate = S.rate >= 8 ? 1 : S.rate * 2; syncChrome(); });
  $('#arr').addEventListener('click', () => {
    S.arrivals = !S.arrivals; $('#arr').setAttribute('aria-pressed', S.arrivals);
    nextArr = S.t + 5;
    line('sys', '', S.arrivals ? `arrival generator on — ${A.fleet.length ? A.id + ' fleet mix' : 'generic GA mix'}` : 'arrival generator off');
  });
  /* STARS pane controls */
  document.querySelectorAll('#viewbar button').forEach((b) => b.addEventListener('click', () => { SET.view = b.dataset.view; saveSettings(); applyMode(); }));
  $('#srng-in').addEventListener('click', () => sRange(Math.max(3, Math.round(sview.w / 2 / 1.5))));
  $('#srng-out').addEventListener('click', () => sRange(Math.min(80, Math.round(sview.w / 2 * 1.5))));
  $('#sctr').addEventListener('click', () => sRange(15));
  $('#smaps-btn').addEventListener('click', () => { const p = $('#smaps'); p.hidden = !p.hidden; });
  $('#smaps').addEventListener('change', (e) => {
    const cb = e.target; if (!cb.dataset?.id) return;
    if (cb.checked) { STARS_SEL.add(cb.dataset.id); showStarsMap(cb.dataset.id); }
    else { STARS_SEL.delete(cb.dataset.id); sMaps.querySelector(`[data-id="${cb.dataset.id}"]`)?.remove(); }
  });
  ssvg.addEventListener('wheel', (e) => { e.preventDefault(); sZoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.13 : 0.885); }, { passive: false });
  let sdrag = null;
  ssvg.addEventListener('pointerdown', (e) => { sdrag = { x: e.clientX, y: e.clientY, vx: sview.x, vy: sview.y, moved: false }; ssvg.setPointerCapture(e.pointerId); });
  ssvg.addEventListener('pointermove', (e) => {
    if (!sdrag) return;
    const r = ssvg.getBoundingClientRect();
    if (Math.hypot(e.clientX - sdrag.x, e.clientY - sdrag.y) > 3) sdrag.moved = true;
    sview.x = sdrag.vx - (e.clientX - sdrag.x) * (sview.w / r.width); sview.y = sdrag.vy - (e.clientY - sdrag.y) * (sview.h / r.height);
    ssvg.setAttribute('viewBox', `${sview.x} ${sview.y} ${sview.w} ${sview.h}`);
  });
  ssvg.addEventListener('pointerup', (e) => {
    if (sdrag && !sdrag.moved && RC) {
      const r = ssvg.getBoundingClientRect();
      const wx = sview.x + sview.w * ((e.clientX - r.left) / r.width), wy = sview.y + sview.h * ((e.clientY - r.top) / r.height);
      let best = null, bd = Infinity;
      for (const a of S.ac) { if (!a.radar) continue; const [x, y] = PS(a.radar.pos); const d = Math.hypot(x - wx, y - wy); if (d < bd) { bd = d; best = a; } }
      if (best && bd < sview.w * 0.04) { selectAc(best); $('#cmd').focus(); }
    }
    sdrag = null;
  });
  ssvg.addEventListener('pointercancel', () => { sdrag = null; });

  $('#zin').addEventListener('click', () => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.7); });
  $('#zout').addEventListener('click', () => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.42); });
  $('#zfit').addEventListener('click', fit);

  svg.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.13 : 0.885); }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; svg.setPointerCapture(e.pointerId); svg.classList.add('drag'); });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = svg.getBoundingClientRect();
    const dx = (e.clientX - drag.x) * (view.w / r.width), dy = (e.clientY - drag.y) * (view.h / r.height);
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 3) drag.moved = true;
    view.x = drag.vx - dx; view.y = drag.vy - dy; applyView();
  });
  svg.addEventListener('pointerup', (e) => {
    svg.classList.remove('drag');
    if (drag && !drag.moved && G) {
      const r = svg.getBoundingClientRect();
      const wx = view.x + view.w * ((e.clientX - r.left) / r.width), wy = view.y + view.h * ((e.clientY - r.top) / r.height);
      let best = null, bd = Infinity;
      for (const a of S.ac) { if (a.state === 'DEP') continue; const c = P(a.pos), d = Math.hypot(c[0] - wx, c[1] - wy); if (d < bd) { bd = d; best = a; } }
      if (best && bd < view.w * 0.035) { selectAc(best); $('#cmd').focus(); }
    }
    drag = null;
  });
  svg.addEventListener('pointercancel', () => { drag = null; svg.classList.remove('drag'); });

  $('#strips').addEventListener('click', (e) => {
    const s = e.target.closest('.strip'); if (!s) return;
    const a = S.ac.find((x) => x.cs === s.dataset.cs); if (a) selectAc(a);
    $('#cmd').focus();
  });
  $('#strips').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const s = e.target.closest('.strip'); if (!s) return;
    e.preventDefault();
    const a = S.ac.find((x) => x.cs === s.dataset.cs); if (a) selectAc(a);
  });

  const hist = []; let hi = -1;
  $('#cmd').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { if (hi < hist.length - 1) { hi++; e.target.value = hist[hi]; } e.preventDefault(); }
    else if (e.key === 'ArrowDown') { if (hi > 0) { hi--; e.target.value = hist[hi]; } else { hi = -1; e.target.value = ''; } e.preventDefault(); }
  });
  window.submitText = (v) => {
    v = String(v || '').trim(); if (!v || !G) return;
    hist.unshift(v); hi = -1;
    const r = runCommand(v);
    if (r.unknown) askAI(v);
    else if (r.ok) line('atc', null, v);
    syncSel(); renderStrips();
  };
  $('#cmdform').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#cmd'); const v = inp.value; inp.value = '';
    submitText(v);
  });

  /* push-to-talk: on-screen button, or hold Space outside the command box */
  const pttBtn = $('#ptt');
  pttBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); pttBtn.setPointerCapture(e.pointerId); pttStart(); });
  ['pointerup', 'pointercancel'].forEach((ev) => pttBtn.addEventListener(ev, () => pttStop()));
  pttBtn.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') e.preventDefault(); });
  const typing = () => { const el = document.activeElement; return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') && el.id !== 'ptt'; };
  addEventListener('keydown', (e) => {
    if (e.key !== ' ' || e.repeat || typing() || document.querySelector('dialog[open]')) return;
    e.preventDefault(); pttStart();
  });
  addEventListener('keyup', (e) => { if (e.key === ' ' && ptt) { e.preventDefault(); pttStop(); } });
  addEventListener('blur', () => pttStop());
  $('#tts-btn').addEventListener('click', () => {
    SET.tts = !SET.tts; saveSettings(); syncHint();
    if (!SET.tts) stopSpeaking();
    line('sys', '', SET.tts ? 'pilot voices on' : 'pilot voices off');
  });
  $('#help-btn').addEventListener('click', () => $('#help').showModal());
  $('#help-x').addEventListener('click', () => $('#help').close());
  addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== $('#cmd') && !document.querySelector('dialog[open]')) { e.preventDefault(); $('#cmd').focus(); }
    if (e.key === 'Escape' && document.activeElement === $('#cmd')) $('#cmd').blur();   /* free Space for PTT */
  });

  /* settings */
  const status = (msg, cls) => { const s = $('#s-status'); s.textContent = msg || ''; s.className = 'status ' + (cls || ''); };
  $('#set-btn').addEventListener('click', () => {
    $('#s-key').value = SET.key; $('#s-model').value = SET.model; $('#s-proxy').value = SET.proxy;
    $('#s-audio').value = SET.audioModel; $('#s-tts').checked = !!SET.tts; $('#s-radio').checked = !!SET.radio;
    $('#s-engine').value = SET.ttsEngine; $('#s-ttsmodel').value = SET.ttsModel;
    loadVoices(); fillVoiceSelect();
    if (SET.ttsEngine === 'openrouter') loadTtsModels().then(fillVoiceSelect).catch((e) => status(`could not load speech models: ${e.message}`, 'bad'));
    status('');
    $('#settings').showModal();
  });
  $('#s-engine').addEventListener('change', () => {
    fillVoiceSelect();
    if ($('#s-engine').value === 'openrouter') loadTtsModels().then(fillVoiceSelect).catch((e) => status(`could not load speech models: ${e.message}`, 'bad'));
  });
  $('#s-ttsmodel').addEventListener('input', () => { if ($('#s-engine').value === 'openrouter') fillVoiceSelect(); });
  $('#s-testvoice').addEventListener('click', () => {
    const engine = $('#s-engine').value, model = $('#s-ttsmodel').value.trim() || 'hexgrad/kokoro-82m', voice = $('#s-voice').value;
    const sample = 'Runway three zero left, taxi via quebec, charlie, hold short of runway one two right, Delta ten forty-seven';
    if (engine === 'openrouter') {
      const key = $('#s-key').value.trim();
      if (!key) { status('OpenRouter voices need an API key', 'bad'); return; }
      const saved = SET.key; SET.key = key;
      status('fetching speech…');
      fetchSpeech(sample, model, pickVoice('DAL1047', model, voice))
        .then((buf) => { status(`playing ${model}${voice ? ' · ' + voice : ''} (${buf.duration.toFixed(1)}s)`, 'ok'); return playBuffer(buf, $('#s-radio').checked); })
        .catch((e) => status(`speech failed: ${e.message}`, 'bad'))
        .finally(() => { SET.key = saved; });
    } else { speakBrowser('DAL1047', sample, voice); status('playing browser voice', 'ok'); }
  });
  $('#set-x').addEventListener('click', () => $('#settings').close());
  $('#s-models').addEventListener('click', async () => {
    status('loading model list…');
    try {
      const j = await getJSON(`${OR}/models`);
      const all = (j.data || []);
      const ids = all.map((m) => m.id).sort();
      const audio = all.filter((m) => (m.architecture?.input_modalities || []).includes('audio')).map((m) => m.id).sort();
      $('#models').innerHTML = ids.map((id) => `<option value="${esc(id)}">`).join('');
      $('#audiomodels').innerHTML = audio.map((id) => `<option value="${esc(id)}">`).join('');
      const tts = await loadTtsModels();
      if ($('#s-engine').value === 'openrouter') fillVoiceSelect();
      $('#s-models-note').textContent = `${ids.length} models available on OpenRouter (${audio.length} accept audio) — start typing in a Model box to filter.`;
      status(`${ids.length} models loaded, ${audio.length} with audio input, ${Object.keys(tts).length} speech models`, 'ok');
    } catch (e) { status(`could not load models: ${e.message}`, 'bad'); }
  });
  $('#s-test').addEventListener('click', async () => {
    const key = $('#s-key').value.trim(), model = $('#s-model').value.trim();
    if (!key || !model) { status('enter a key and a model first', 'bad'); return; }
    const saved = { key: SET.key, model: SET.model };
    Object.assign(SET, { key, model });
    status('testing…');
    try {
      const out = await orChat([{ role: 'user', content: 'Reply with exactly the JSON {"ok":true} and nothing else.' }], 30);
      const j = parseJSONish(out);
      status(j.ok ? `works — ${model} answered` : `answered, but not as JSON: ${out.slice(0, 60)}`, j.ok ? 'ok' : 'bad');
    } catch (e) { status(`failed: ${e.message}`, 'bad'); }
    Object.assign(SET, saved);
  });
  $('#s-save').addEventListener('click', () => {
    const proxyBefore = SET.proxy;
    SET.key = $('#s-key').value.trim(); SET.model = $('#s-model').value.trim() || 'anthropic/claude-haiku-4.5';
    SET.audioModel = $('#s-audio').value.trim() || 'google/gemini-3.5-flash-lite';
    SET.tts = $('#s-tts').checked; SET.radio = $('#s-radio').checked;
    SET.ttsEngine = $('#s-engine').value; SET.ttsModel = $('#s-ttsmodel').value.trim() || 'hexgrad/kokoro-82m';
    if (SET.ttsEngine === 'openrouter') SET.ttsVoice = $('#s-voice').value; else SET.voice = $('#s-voice').value;
    SET.proxy = $('#s-proxy').value.trim();
    saveSettings(); syncHint(); $('#settings').close();
    line('sys', '', aiEnabled() ? `plain-English commands on via OpenRouter (${SET.model})` : 'plain-English commands off — command syntax only');
    if (SET.proxy !== proxyBefore) { cache.clear(); boot(); }
  });

  $('#keys').innerHTML = [['--ink-3', 'at the gate'], ['--violet', 'pushback'], ['--green', 'taxiing'], ['--amber', 'holding short'], ['--red', 'stopped'], ['--cyan', 'runway / airborne']]
    .map(([t, l]) => `<span><i style="background:var(${t})"></i>${l}</span>`).join('');
  $('#skeys').innerHTML = [['--ink-2', 'untracked · beacon + alt'], ['--green', 'tracked · TRACK'], ['--accent', 'handoff · CD'], ['--map', 'video map']]
    .map(([t, l]) => `<span><i style="background:var(${t})"></i>${l}</span>`).join('');
}

applyMode(); syncHint(); syncChrome(); setRunning(true);
boot();
