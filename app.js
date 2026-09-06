/* vNAS Ground Trainer — browser app.
   Loads any vNAS training airport (from the baked catalog, or live via a proxy),
   builds the taxiway graph in the browser, and runs the ground simulation. */
import { API, FILES, compactMap, compactScenario, facilityIndex, parseLenientJSON, scenarioForAirport } from './lib/vnas.mjs';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const NS = 'http://www.w3.org/2000/svg';

/* ================= settings ================= */
const SET_KEY = 'vgt.settings';
const SET = { key: '', model: 'anthropic/claude-haiku-4.5', proxy: '' };
try { Object.assign(SET, JSON.parse(localStorage.getItem(SET_KEY) || '{}')); } catch { /* ignore */ }
function saveSettings() { try { localStorage.setItem(SET_KEY, JSON.stringify(SET)); } catch { /* ignore */ } }
const aiEnabled = () => !!(SET.key && SET.model);

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
  }, o);
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
    if (b === a || b.state === 'PARKED' || b.state === 'DEP' || b.state === 'FINAL') continue;
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
  if (a.state === 'TKOF') {
    a.spd = Math.min(ROLL_KT, a.spd + 7 * dt); advance(a, dt);
    if (!a.path || a.leg >= a.path.length - 1) { a.state = 'DEP'; say(a, 'airborne', 'sys'); }
    return;
  }
  if (a.state === 'FINAL') {
    a.spd = 140; advance(a, dt);
    if (!a.path || a.leg >= a.path.length - 1) a.state = 'ROLLOUT';
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
      say(a, `holding short of ${a.rwy || nm || 'the runway'}`, 'pilot');
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
    if (a._luaw) { a._luaw = false; a.state = 'LUAW'; say(a, `lined up runway ${a.rwy}`, 'pilot'); return; }
    if (a.destGate) { a.state = 'PARKED'; a.gate = a.destGate; a.destGate = null; say(a, `in the blocks at ${a.gate}`, 'pilot'); return; }
    if (a.rwy) { a.state = 'SHORT'; say(a, `holding short of ${a.rwy}`, 'pilot'); return; }
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
  say(a, `clear of the runway${NODE_TW[bestNode] ? ' at ' + [...NODE_TW[bestNode]][0] : ''}`, 'pilot');
}

/* ================= log ================= */
const LOG = $('#log');
function line(kind, who, msg) {
  const el = document.createElement('div');
  el.className = 'line ' + kind;
  const mm = String(Math.floor(S.t / 60)).padStart(2, '0'), ss = String(Math.floor(S.t % 60)).padStart(2, '0');
  el.innerHTML = `<span class="t">${mm}:${ss}</span><span class="m">${who ? `<span class="who">${esc(who)}</span> ` : ''}${esc(msg)}</span>`;
  LOG.prepend(el);
  while (LOG.children.length > 140) LOG.lastChild.remove();
  return el;
}
const say = (a, msg, kind) => line(kind || 'pilot', a.cs, msg);

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
  return out.join(' ');
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
    say(a, `pushing back off ${a.gate}`, 'pilot'); return null;
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
    say(a, `runway ${rw}, taxi via ${routeSummary(a) || 'the field'}`, 'pilot'); return null;
  },
  HS(a, args) {
    if (!args.length || !a.path) return 'hold short of what?';
    const T = args[0].toUpperCase();
    for (let i = a.leg; i + 1 < a.path.length; i++) {
      const nm = edgeName(a.path[i], a.path[i + 1]);
      if (nm === T || nm === (G.rwy[T] && G.rwy[T].rw)) { a.holdLeg = i; say(a, `hold short of ${T}`, 'pilot'); return null; }
    }
    return `${T} is not on the route`;
  },
  CROSS(a, args) {
    const nm = a.holdLeg != null ? edgeName(a.path[a.holdLeg], a.path[a.holdLeg + 1]) : (a.rwy ? G.rwy[a.rwy].rw : null);
    if (!nm) return 'not holding short of anything';
    a.cleared.add(nm);
    a.holdLeg = firstRwyLeg(a, a.leg);
    if (a.state === 'SHORT') a.state = 'TAXI';
    say(a, `crossing ${args[0] ? args[0].toUpperCase() : nm}`, 'pilot'); return null;
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
    a.giveway = o.cs; say(a, `giving way to ${o.cs}`, 'pilot'); return null;
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
    say(a, `cleared for takeoff runway ${a.rwy}`, 'pilot'); return null;
  },
  EXIT(a) {
    if (a.state !== 'ROLLOUT' && a.state !== 'HOLD') return 'not on a landing roll';
    autoExit(a); return null;
  },
  GA(a) {
    if (a.state !== 'FINAL') return 'not on final';
    a.state = 'DEP'; say(a, 'going around', 'pilot'); return null;
  },
  SQ(a, args) { if (!args[0]) return 'squawk what?'; a.sq = args[0]; a.xpdr = 'N'; say(a, `squawking ${a.sq}`, 'pilot'); return null; },
  SN(a) { a.xpdr = 'N'; say(a, 'squawking normal', 'pilot'); return null; },
  SS(a) { a.xpdr = 'S'; say(a, 'squawk standby', 'pilot'); return null; },
  ID(a) { a.xpdr = 'I'; say(a, 'ident', 'pilot'); setTimeout(() => { if (a.xpdr === 'I') a.xpdr = 'N'; }, 4000); return null; },
  SAY(a, args) {
    const w = (args[0] || '').toUpperCase();
    if (w === 'GATE') say(a, `we're at ${a.gate || 'no gate'}`, 'pilot');
    else if (w === 'TYPE') say(a, `we're a ${a.ty}`, 'pilot');
    else if (w === 'RWY' || w === 'RUNWAY') say(a, a.rwy ? `expecting runway ${a.rwy}` : 'no runway assigned', 'pilot');
    else say(a, `${a.ty} at ${a.gate || '—'}, ${a.dep || A.id} to ${a.dst || '—'}`, 'pilot');
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
async function orChat(messages, maxTokens = 400) {
  const r = await fetch(`${OR}/chat/completions`, {
    method: 'POST', headers: orHeaders(),
    body: JSON.stringify({ model: SET.model, messages, temperature: 0, max_tokens: maxTokens }),
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
HS <pt> | CROSS | RES | HOLD | BREAK | GIVEWAY <callsign> | LUAW | CTO | EXIT | GA |
SQ <code> | SN | SS | ID | SAY <gate|type|rwy> | DEL | TAXIALL`;
function syncHint() {
  const h = $('#hint');
  h.textContent = aiEnabled() ? `plain English via ${SET.model}` : 'commands only · add a key in Settings';
  h.classList.toggle('ai', aiEnabled());
  $('#set-btn').classList.toggle('ai-on', aiEnabled());
}
async function askAI(text) {
  if (!aiEnabled()) { line('err', '', 'unrecognised command — see Commands, or add an OpenRouter key in Settings for plain English'); return; }
  const roster = S.ac.filter((a) => a.state !== 'DEP').slice(0, 60).map((a) =>
    `${a.cs} (${a.ty}) ${a.state}${a.gate ? ` gate ${a.gate}` : ''}${a.rwy ? ` rwy ${a.rwy}` : ''}`).join('; ');
  const gates = Object.keys(GATES);
  const pending = line('ai', '', 'translating…');
  try {
    const sys = `You are the pilot side of an air traffic control ground simulator at ${A.name} (${A.id}).
Translate one controller transmission into ATCTrainer commands.

COMMANDS: ${CMD_REF}
Taxiways here: ${Object.keys(TW).join(' ') || 'none'}
Runways: ${Object.keys(G.rwy).join(' ')}
Gates and spots (${gates.length}): ${gates.slice(0, 40).join(' ')}${gates.length > 40 ? ' …' : ''}

Reply with ONLY a JSON object:
{"callsign":"<exact callsign from the roster, or null>",
 "commands":["<command line>", ...],
 "readback":"<how the pilot would read it back, one short line, no callsign prefix>"}
If the transmission is not an instruction to a specific aircraft, use "callsign":null and an empty commands array with a readback explaining briefly.`;
    const user = `AIRCRAFT ON FREQUENCY: ${roster || 'none'}
CURRENTLY SELECTED: ${S.sel ? S.sel.cs : 'none'}

CONTROLLER SAID: ${JSON.stringify(text)}`;
    const out = parseJSONish(await orChat([{ role: 'system', content: sys }, { role: 'user', content: user }]));
    pending.remove();
    const a = out.callsign ? findAc(out.callsign) : S.sel;
    if (!a) { line('err', '', `no aircraft matched "${out.callsign || '—'}"${out.readback ? ' — ' + out.readback : ''}`); return; }
    S.sel = a;
    line('atc', null, text);
    let bad = false;
    for (const c of out.commands || []) {
      const r = runCommand(`${a.cs} ${c}`);
      if (r.unknown) { line('err', a.cs, `could not run "${c}"`); bad = true; }
      else if (!r.ok) bad = true;
    }
    if (out.readback && !bad) line('pilot', a.cs, out.readback);
    renderStrips();
  } catch (e) {
    pending.remove();
    line('err', '', `could not translate that (${e.message}) — try the command syntax`);
  }
}

/* ================= scenarios ================= */
function loadScenario(sc) {
  CUR_SCEN = sc;
  S.ac = []; S.t = 0; S.sel = null; S.seq = 0; LOG.innerHTML = '';
  let skipped = 0;
  for (const r of sc ? sc.ac : []) {
    const a = Aircraft({ cs: r.cs, ty: r.ty, dep: r.dep, dst: r.dst, delay: r.d || 0, sq: String(1000 + Math.floor(Math.random() * 6000)), xpdr: 'S' });
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
      a.xpdr = 'N';
    } else { skipped++; continue; }
    S.ac.push(a);
  }
  if (sc) {
    line('sys', '', `${sc.name} — ${S.ac.length} surface aircraft${sc.air ? `, ${sc.air} airborne not loaded` : ''}${skipped ? `, ${skipped} unplaced` : ''}.${sc.stu ? ` Student position ${sc.stu}.` : ''}`);
  } else line('sys', '', `${A.name} — empty field. Switch on Arrivals, or pick a scenario.`);
  const rw = Object.keys(G.rwy)[0] || '—', tw = Object.keys(TW).slice(0, 2).join(' ');
  line('sys', '', Object.keys(TW).length
    ? `Select an aircraft, then try: PUSH · RWY ${rw} TAXI ${tw} · CROSS · LUAW · CTO`
    : `This training map has runways only — no taxiways, so PUSH and TAXI are unavailable here. Try: LUAW · CTO · Arrivals.`);
  nextArr = 0;
  fit(); renderStrips(); syncChrome(); syncSel();
}
function placeOnFinal(a, rw, nm) {
  const info = G.rwy[rw];
  const thr = NODES[info.chain[0]];
  const crs = bearing(NODES[info.chain[0]], NODES[info.chain[1]]);
  a.pos = movePt(thr, (crs + 180) % 360, nm * 6076); a.hdg = crs; a.spd = 140;
  a.state = 'FINAL'; a.rwy = rw;
  a._origin = a.pos.slice(); a.path = info.chain.slice(); a.leg = 0; a.frac = 0; a.holdLeg = null;
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
  placeOnFinal(a, rw, 3);
  if (GATE_NAMES.length) a.destGate = GATE_NAMES[Math.floor(Math.random() * GATE_NAMES.length)];
  S.ac.push(a);
  line('sys', '', `${a.cs} ${a.ty} on final runway ${rw}${a.destGate ? `, parking ${a.destGate}` : ''}`);
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
    svgEl('circle', { cx: c[0].toFixed(0), cy: c[1].toFixed(0), r: 3.2 * U, opacity: g.spot ? .3 : .45 }, gStatic).style.fill = g.spot ? 'var(--amber)' : 'var(--net)';
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
  LUAW: 'var(--cyan)', TKOF: 'var(--cyan)', FINAL: 'var(--cyan)', ROLLOUT: 'var(--cyan)', DEP: 'var(--ink-3)',
};
const STATE_TEXT = { PARKED: 'gate', PUSH: 'push', PUSHED: 'ready', TAXI: 'taxi', SHORT: 'short', HOLD: 'hold', LUAW: 'luaw', TKOF: 'roll', FINAL: 'final', ROLLOUT: 'rollout', DEP: 'airborne' };
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
  const rank = (a) => a.delay > 0 ? 8 : ({ TKOF: 0, LUAW: 1, SHORT: 2, TAXI: 3, PUSH: 3, PUSHED: 4, HOLD: 2, FINAL: 0, ROLLOUT: 1, PARKED: 6 })[a.state] ?? 7;
  const list = S.ac.filter((a) => a.state !== 'DEP').sort((a, b) => rank(a) - rank(b) || a.cs.localeCompare(b.cs));
  const pend = list.filter((a) => a.delay > 0).length;
  $('#cnt').textContent = `${list.length - pend} on frequency${pend ? ` · ${pend} pending` : ''}`;
  $('#strips').innerHTML = list.map((a) => {
    const pending = a.delay > 0;
    const col = pending ? 'var(--ink-3)' : (STATE_COLOR[a.state] || 'var(--ink)');
    return `<div class="strip" data-cs="${esc(a.cs)}" aria-selected="${S.sel === a}" role="button" tabindex="0"${pending ? ' style="opacity:.55"' : ''}>
      <span class="cs">${esc(a.cs)}</span>
      <span class="st" style="color:${col}">${pending ? 'pending' : (STATE_TEXT[a.state] || a.state)}</span>
      <span class="sub"><b>${esc(a.ty)}</b>${a.gate ? `<b>${esc(a.gate)}</b>` : ''}${a.rwy ? `<b>rwy ${esc(a.rwy)}</b>` : ''}${a.dst ? `<b>→ ${esc(a.dst)}</b>` : ''}${a.delay > 0 ? `<b>+${Math.ceil(a.delay)}s</b>` : ''}${a.blockedBy ? `<b>behind ${esc(a.blockedBy)}</b>` : ''}</span>
    </div>`;
  }).join('');
}
function selectAc(a) { S.sel = a; syncSel(); renderStrips(); }
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
    for (const a of S.ac) step(a, STEP);
    maybeArrival();
  }
  renderStrips();
}
setInterval(physics, STEP * 1000);
window.__vgt = { S, get G() { return G; }, get A() { return A; }, runCommand };
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
  buildStatic(); loadPavement(doc);
  const sel = $('#scen');
  sel.innerHTML = `<option value="">— empty field —</option>` +
    doc.scen.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}${s.ac ? ` — ${s.ac.length}` : ''}</option>`).join('');
  sel.disabled = false;
  document.title = `${doc.id} · vNAS Ground Trainer`;
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
  $('#cmdform').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#cmd');
    const v = inp.value.trim(); if (!v || !G) return;
    hist.unshift(v); hi = -1; inp.value = '';
    const r = runCommand(v);
    if (r.unknown) askAI(v);
    else if (r.ok) line('atc', null, v);
    syncSel(); renderStrips();
  });
  $('#help-btn').addEventListener('click', () => $('#help').showModal());
  $('#help-x').addEventListener('click', () => $('#help').close());
  addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== $('#cmd') && !document.querySelector('dialog[open]')) { e.preventDefault(); $('#cmd').focus(); }
  });

  /* settings */
  const status = (msg, cls) => { const s = $('#s-status'); s.textContent = msg || ''; s.className = 'status ' + (cls || ''); };
  $('#set-btn').addEventListener('click', () => {
    $('#s-key').value = SET.key; $('#s-model').value = SET.model; $('#s-proxy').value = SET.proxy; status('');
    $('#settings').showModal();
  });
  $('#set-x').addEventListener('click', () => $('#settings').close());
  $('#s-models').addEventListener('click', async () => {
    status('loading model list…');
    try {
      const j = await getJSON(`${OR}/models`);
      const ids = (j.data || []).map((m) => m.id).sort();
      $('#models').innerHTML = ids.map((id) => `<option value="${esc(id)}">`).join('');
      $('#s-models-note').textContent = `${ids.length} models available on OpenRouter — start typing in the Model box to filter.`;
      status(`${ids.length} models loaded`, 'ok');
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
    SET.proxy = $('#s-proxy').value.trim();
    saveSettings(); syncHint(); $('#settings').close();
    line('sys', '', aiEnabled() ? `plain-English commands on via OpenRouter (${SET.model})` : 'plain-English commands off — command syntax only');
    if (SET.proxy !== proxyBefore) { cache.clear(); boot(); }
  });

  $('#keys').innerHTML = [['--ink-3', 'at the gate'], ['--violet', 'pushback'], ['--green', 'taxiing'], ['--amber', 'holding short'], ['--red', 'stopped'], ['--cyan', 'runway']]
    .map(([t, l]) => `<span><i style="background:var(${t})"></i>${l}</span>`).join('');
}

syncHint(); syncChrome(); setRunning(true);
boot();
