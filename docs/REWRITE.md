# vNAS Trainer rewrite: Foldkit on Effect v4

This is the brief for rewriting the trainer from the single-file `app.js` into a
Foldkit (Elm-architecture) application on Effect v4. It records decisions already
made, facts already verified, the behaviour the new app must reproduce, and the order
of work. Treat the current app as the behavioural spec; it is correct and tested.
Do not re-litigate the decisions below without asking.

## 1. Decisions (settled)

| Topic | Decision |
|---|---|
| Framework | **Foldkit** (`foldkit` 0.158.x, Elm architecture: Model / Message / update / view / Command / Subscription). Pin the version. |
| Effect | **`effect@4.0.0-rc.112`** exactly (Foldkit's peer pin). Atoms are *not* used; Foldkit's Model replaces them. |
| Types | **`Schema.Struct` everywhere.** Never `Schema.Class`. Messages via `defineMessageUnion`, commands and events as tagged-struct unions. |
| Sim core | **Pure reducer.** Physics, command execution, arrivals, phraseology are pure functions over an immutable `WorldState` in the Model, driven by messages. Effects are only for the outside world (fetch, OpenRouter, audio, storage). |
| Determinism | **PRNG state lives in the Model** (xorshift32). Every random draw (squawks, fleet pick, gate pick, voice pick, arrival timing) goes through it. The sim advances in fixed 0.1 s steps on a 10 Hz wall-clock `Ticked` message (catch-up capped at 40 steps); the Model keeps a **command log** of `{ tick, callsign, command }`, so init + ticks + that log replays a session exactly. DevTools history is capped at 500 entries (spike finding), so it is a debugging aid, not the event log; `Ticked` is excluded from it. |
| Scopes | **Canvas** via Foldkit's `Canvas` module for both the ground view and STARS. Chrome (header, strips, log, dialogs) in the Html DSL. |
| Positions | Ground, Local (tower), later TRACON and En-Route, each a Foldkit **Submodel** contributing its commands, panes, prompt fragments and arrival rules. No mode checks in the domain. |
| Phraseology | **Phrase tokens**, not string markup: a `Phrase` is an array of `{ text } | { runway } | { taxiways } | { gate } | { frequency } | { digits } | { callsign }` with two renderers, `written` and `spoken`. |
| Toolchain | **Bun as package manager** (`bun install`, `bun run`, `bunx`). **Vite** for dev server and build (Foldkit ships a Vite HMR protocol). `bun test` for domain and Story tests; vitest via `bunx` only if Scene (view) tests are wanted. `bunx tsc --noEmit` for typecheck. |
| Legacy | Move today's app to `legacy/` untouched and keep it deployable at `/legacy/` until parity. |
| Catalog | Keep the baked-catalog approach (vNAS `/api/*` has no CORS). Builder becomes TypeScript run with Bun, importing the same Schemas, so catalog files are validated at build time and decoded at load time. |
| Hosting | GitHub Pages via Actions: `oven-sh/setup-bun`, `bun install --frozen-lockfile`, build catalog, typecheck, test, `vite build`, copy `catalog/` and `legacy/` into `dist/`, upload. |

## 2. Verified framework facts (do not re-research)

**Effect v4 rc** (`effect@4.0.0-rc.112`)
- Services: `class Foo extends Context.Service<Foo, Shape>()("Foo") {}`; layers via `Layer.effect` / `Layer.succeed`; wire dependencies with `Layer.provide` (no `dependencies` option).
- Schema: `Schema.Struct`, `Schema.Literals([...])`, `Schema.Union([...])` (arrays, not variadic), `Schema.Array`, `Schema.optionalKey` (exact) / `Schema.optional` (allows undefined), filters via `Schema.check(Schema.isBetween(a, b))`, decoding via `Schema.decodeUnknownEffect` / `Schema.decodeUnknownSync`, `Schema.Schema.Type<typeof S>`.
- HTTP client lives at `effect/unstable/http`. Testing utilities at `effect/testing` (TestClock, TestConsole, FastCheck). `Random.withSeed("…")` exists but is not needed with the in-model PRNG.
- The reactivity/atom module is `effect/unstable/reactivity`; not used here.

**Foldkit 0.158** (`import { Runtime, Html, Canvas, Command, Subscription, ManagedResource, Port, Submodel, AsyncData, Message, Update, Route, Story, Scene } from "foldkit"` plus subpaths like `foldkit/test`)
- `Runtime.makeApplication({ Model, init, update, view, container, subscriptions?, resources?: Layer, managedResources?, ports?, devTools?, routing?, freezeModel? })`, then `Runtime.run(app)`.
- `update: (model, message) => Update.Return<Model, Message, Resources>` returning `{ model, command? }`; `Message.match(message, { Tag: (payload) => … })`; `evo(model, { field: fn })` for updates.
- `view: (model, h: HtmlBuilder<Message>) => Document` (`{ title, body }`), e.g. `h.button([h.OnClick(Message.ClickedX())], ["+"])`.
- `Subscription.make<Model, Message, Services>()(build => ({ … }))`, `Subscription.animationFrame({ isActive: model => boolean, toMessage: (deltaTime) => Message })`, `Subscription.fromEvent`, `Subscription.persistent`, `Subscription.aggregate`.
- `Canvas`: `view` plus shapes `Path`, `MoveTo`, `LineTo`, `QuadTo`, `BezierTo`, `Close`, `Rect`, `Circle`, `Text`, `Group`, `Point`, line caps/joins, text align/baseline.
- `ManagedResource.make` for stateful handles (AudioContext, microphone). `Port.inbound/outbound/stream/subscription/emit` for JS interop (e.g. `speechSynthesis`).
- `AsyncData` for loading states. `Submodel` for splitting update/view.
- Tests: `Story` (`given`, `message`, `model`, `steps`, `Command.expectExact`, `Command.resolve`, `expectOutMessage`) runs update purely with Commands kept as data; runner-agnostic. `Scene` tests and the matchers under `foldkit/test/vitest` are vitest-specific.
- Scaffold reference: `npx create-foldkit-app@latest` (look at its output for the canonical Vite config, but we scaffold by hand to keep control).

**Bun 1.3** is installed. Use it for `bun install`, `bun run <script>`, `bunx`, `bun test`, and to run TypeScript scripts directly (`bun run scripts/build-catalog.ts`).

**Phase 0 spike findings (2026-09-06)**
- HMR: `@foldkit/vite-plugin` does a full reload and restores the Model; the sim clock continues across an edit.
- `bun test` runs `foldkit/story` as is (`expect` from `bun:test`); vitest is only needed for Scene tests.
- `Canvas.view` repaints the whole shape list on every render and does no device-pixel-ratio scaling: size the backing store `css * dpr` and wrap the scene in a `Group` with `scale`. Static layers are memoised per Graph value. 82 moving aircraft plus the MSP graph held 120 fps (p95 9.3 ms).
- DevTools: history capped at 500 entries (default 100, `maxEntries` clamps to 20..500); the overlay serialises the Model per message, so with a 60-120 Hz tick flood frames went to 200-400 ms while it was open. Hence the 10 Hz tick and `excludeFromHistory: ['Ticked']`. TimeTravel mode rewinds fine.
- Building the graph inside `update` on load takes ~28 ms (one Foldkit slow-update warning); acceptable.

**Performance rules (learned the hard way, 2026-09-06)**
- **`defineTaggedUnion` / `defineMessageUnion` constructors decode their payload through the Schema and rebuild the whole object tree.** Calling `AirportLoad.Ready({ info, world })` on every tick deep-copied the graph and every aircraft (~10 ms) and gave every value a new identity, which defeats every memo. On hot paths build the variant as a plain literal (`{ _tag: 'Ready', info, world }`); use the constructors only for small payloads or one-off transitions.
- `createLazy` memoises by argument identity. Pass only referentially stable values (the graph, the scope view record, primitive ids) and never the per-render `h` builder; a memoised subtree that needs no handlers takes `inertHtml`.
- `Canvas.view` repaints its whole shape list on every render. Each scope is two stacked canvases: a static one (pavement, network, rings, video maps) under `createLazy`, repainted only when the viewport or map set changes, and a dynamic one for targets and pointer events.
- Video maps carry far more vertices than a scope can show (MSP's default STARS set is ~180,000 segments). Their projected coordinates are cached per map (`worldRings`, `nmRings` as flat `Float64Array`s) and decimated to screen resolution (`decimatedFlatPath`, 0.75 px) on every viewport change. Before this the radar repainted 180k segments seven times a second (430 ms per render).
- Only wire `onPointerMove` while a drag is active; pointer and wheel messages are excluded from DevTools history.
- Measured after the fixes at MSP, Local, both panes: full frame rate, no long tasks, strip select 9 ms, wheel zoom ~15 ms per step, drag 16-25 ms per frame. If dragging still feels heavy, move the static canvas with a CSS transform during the drag and repaint on release.

**Audio rule (2026-09-06, user heard no pilots)**
- Commands run outside the user gesture, so an `AudioContext` created by a Speak command starts suspended and `source.start()` is silent; the legacy app never hit this because it spoke from the DOM event handler. The `Speech` service therefore creates and resumes the context synchronously on the first pointer or key event (`unlockOnGesture`), fails playback when the context is still not running (which falls back to the browser voice and logs once) rather than waiting on an end event that never fires, and keeps a reference to live `SpeechSynthesisUtterance`s so Chrome does not drop them; a picked browser voice that fails to synthesize is retried with the default voice.

**vNAS** (`https://data-api.vnas.vatsim.net`)
- No CORS on `/api/*`. CORS `*` on `/Files/*` (video maps). Hence the baked catalog; an optional user-run CORS proxy (`proxy-worker.js`, `?url=` prefix) enables live mode.
- Endpoints used: `/api/artcc-summaries`, `/api/artccs/{ARTCC}` (facility tree, positions, STARS config, video map metadata), `/api/training/airport-summaries`, `/api/training/airports/{APT}`, `/api/training/airports/{APT}/map` (GeoJSON), `/api/training/scenario-summaries`, `/api/training/scenarios/{ULID}`, `/Files/VideoMaps/{ARTCC}/{id}.geojson`.
- Some airport maps are not valid JSON: `//` comment lines, `010` headings, trailing commas. Repair before parsing (see `lib/vnas.mjs` `parseLenientJSON`).
- Re-verified 2026-09-06 with curl: `/api/*` GET responses carry no `Access-Control-Allow-Origin`; `/Files/*` sends `*`. So browsers need the catalog or a proxy for `/api`, never for video maps. `scripts/dev-proxy.ts` (`bun run proxy`, port 8787, vNAS host only) is the local equivalent of `legacy/proxy-worker.js`; live mode through it lists every scenario for an airport (the catalog keeps only those with surface aircraft) and fetches each on demand.
- `scripts/build-catalog.ts ZMP` (a partial build) merges into the existing `catalog/index.json`; the legacy builder overwrote it, which is how a 195-airport catalog ended up with a 12-airport index.
- Training map spec: features `runway` (LineString, name `"12R - 30L"`, first end primary), `taxiway` (LineString), `parking` and `spot` (Point, `heading`). Vertices within **100 ft** merge into one node.
- The `vnas-api` skill in this environment documents the rest.

**OpenRouter** (CORS-enabled for browsers)
- `POST /api/v1/chat/completions` with `Authorization: Bearer`, `HTTP-Referer`, `X-Title`. Audio input as a content part `{ type: "input_audio", input_audio: { data: <base64>, format: "wav" } }`; models with audio input are `GET /api/v1/models` entries whose `architecture.input_modalities` includes `"audio"`.
- `POST /api/v1/audio/speech` `{ model, input, voice?, response_format: "mp3" | "pcm" }` returns raw audio bytes. Speech models: `GET /api/v1/models?output_modalities=speech`, each with `supported_voices` (may be null).
- `POST /api/v1/audio/transcriptions` exists (Whisper etc.); not used today because the chat+audio call transcribes and translates in one step.

## 3. Target layout

```
legacy/                    today's app, untouched (index.html, app.js, lib/, proxy-worker.js)
catalog/                   built output (gitignored), copied into dist/
scripts/build-catalog.ts   Bun script; imports src/domain schemas; writes catalog/
src/
  domain/                  pure: schemas, geometry, graph, physics, commands, phraseology, prng
  services/                Effect services: VnasData (Catalog | Live), VideoMaps, OpenRouter,
                           Speech (Browser | OpenRouter), Microphone, Settings
  app/                     Foldkit Model, Message, init, update, subscriptions, commands
  positions/               ground/, local/ (submodels: commands, panes, prompt fragments, rules)
  view/                    Html views, Canvas scopes (ground, stars), strips, log, dialogs
  main.ts                  makeApplication + Runtime.run
test/                      bun test: domain unit tests, Story tests
docs/REWRITE.md            this file
index.html, vite.config.ts, tsconfig.json, package.json, bunfig.toml
```

## 4. Order of work

Each phase is one session. Run `bun test` and `bunx tsc --noEmit` before calling a phase done. Ask before committing.

**Phase 0, spike (done 2026-09-06).** Scaffold Bun + Vite + Foldkit + Effect rc pinned. Load `catalog/airports/MSP.json` through a Schema. Draw the taxiway graph on a Canvas scope. `Tick` subscription moves one aircraft. `PUSH` as a command message. One Story test under `bun test`. DevTools rewind working. Findings are in section 2.

**Phase 1, domain (done 2026-09-06).** `src/domain/*` with tests pinning the behaviours in section 5: schemas, PRNG, geometry (feet units), graph builder, routing (Dijkstra with the A* cost model), physics step, command parser, command executor, phraseology, scenario loading, arrivals. The World and its step/execute functions return `SimEvent`s (pilot phrases, system notes, removals, pause/rate) that the app turns into log lines. Three deliberate departures from `legacy/app.js`: taxi routes may name a runway (legacy rejected `TAXI A 12R` as "unfamiliar" although its token resolver accepted it); the automatic "holding short of" line names the hold point (an `HS A3` stop said the departure runway); arrivals taxi from the runway exit to their gate before parking (legacy parked them at the exit node). Position rules (`src/domain/rules.ts`) replace mode checks.

**Phase 2, services and catalog (done 2026-09-06).** `src/domain/vnas.ts` (pure port of `legacy/lib/vnas.mjs`), `src/domain/videomap.ts` (GeoJSON reduced to polygons and lines), `src/services/http.ts` (`HttpText`, the one fetch; an in-memory layer for tests), `VnasData` with `VnasDataCatalog` and `VnasDataLive(proxy)` layers (live mode assembles airport files on the fly and resolves scenarios on demand), `VideoMaps`, `SettingsStore` (legacy `vgt.settings` keys, defaults merged over stored values). `scripts/build-catalog.ts` replaces `build-catalog.mjs`; it validates every file against the schema before writing and reproduced the legacy MSP file byte for byte. The app's `LoadAirport` command goes through `VnasData` supplied as a Foldkit `resources` Layer. Workflow already runs `bun run catalog`, `validate-catalog`, typecheck, tests and the build.

**Phase 3, app and views (done 2026-09-06).** `src/app/` (model, message, commands, subscriptions, update, mapCache), `src/main.ts` boot, `src/view/` (page, header, scope, viewport, strips, deck, dialogs). Boot is a Command chain: settings, deep link, index, airport, then scenario and pavement. The scope is a Foldkit Canvas sized by a `Mount` (`ScopeSurface`) that also delivers wheel deltas, since `OnWheel` carries none; pan and zoom are pure viewport maths in `src/view/viewport.ts`; a resize keeps the visible width in feet like the legacy viewBox. Video-map geometry stays out of the Model in `mapCache.ts` (DevTools snapshots the Model). Dialogs are in-page modals. Position (Ground/Local) swaps the accent and the World's rules; the STARS pane, PTT, AI and voices are stubs until Phases 4 and 5. The lazy static-layer canvas landed with the Phase 4 performance fix (see section 2, performance rules). Model/Message/update, Ground position, Canvas ground scope with ASDE-X pavement, strips, log, command bar, settings, help. Parity with Ground mode.

**Phase 4, Local position (done 2026-09-06).** `src/positions/index.ts` holds the position descriptors (rules, label, tips, placeholder, hasRadar); `src/positions/local/stars.ts` is the STARS pane as a Foldkit Submodel: its own Model (radar view in nm, map selection, drag), Messages, `LoadStarsMap` Command, `StarsSurface` Mount and OutMessages (`SelectedTarget`, `Noted`) folded into the parent with `Update.foldChild`; `src/view/stars.ts` is its `Submodel.defineView` Canvas (rings, runways, video maps, returns with data blocks, MAPS picker, HUD, legend). The parent adds the pane switch (ASDE-X / Both / STARS, persisted as `settings.view`). The flight model, tower commands, arrival rules and check-ins were already in the domain from Phase 1; Local switches the World to `LOCAL_RULES`. Story tests resolve lifted child Commands with the child's raw result message (the runner applies the mapping chain).

**Phase 5, audio and AI (done 2026-09-06).** Domain: `src/domain/prompt.ts` (the system/user prompt and the lenient reply parser), `voices.ts` (hash, English and professional filters, per-callsign picks), `wav.ts`. Services: `OpenRouter` (chat with text or audio parts, model catalogue, speech bytes; key per call), `Speech` (browser speechSynthesis or OpenRouter mp3 through the VHF filter chain, one at a time with fetch-ahead and a 200-entry cache; a failure falls back to the browser voice and is reported once through an event stream), `Microphone` (MediaRecorder to 16 kHz WAV base64, under 0.4 s ignored), `Recognition` (keyless SpeechRecognition with an event stream). The stateful handles live inside these services rather than Foldkit `ManagedResource` entries; each has a fake layer for tests. App: `applyEvents` returns Speak commands for pilot lines (callsign appended unless the phrase carries it); unknown text goes to `TranslateText` when a key is set; the translation runs each command with per-command pilot lines suppressed and speaks the model's single readback (best-effort spoken form when the model gave none); push-to-talk via the button or Space (keyup and window blur release it) with idle/tx/busy/listen states; Settings loads model lists and browser voices, Test key and Test voice report through the status line. Verified in the browser except microphone capture and real OpenRouter calls, which the pane cannot exercise.

**Phase 6, parity and cutover.** Walk the checklist in section 5 against `/legacy/`, then remove legacy from the deploy. Known gaps going in: deleting the selected aircraft leaves its callsign in the command bar (legacy cleared it); the Pages workflow has not run in Actions since the rewrite.

**Phase 7, shared sessions (decided 2026-09-06).** Goal: make training more accessible in the ATCTrainer way, an instructor (or anyone) watching a session live and injecting commands. No backend: WebRTC data channels with **Trystero** for signaling over public infrastructure (Nostr relays by default; BitTorrent, MQTT and IPFS as alternatives), rooms named by app id + room id with password-encrypted session descriptions, default public STUN, and a **TURN server field in Settings** (URL, username, credential; empty by default) passed through as `turnConfig` for symmetric and carrier-grade NAT. Roles are technical only: the **host** created the room and its browser owns the clock and the authoritative World; every **guest** has the same UI and the same permissions, host included. Protocol on the existing determinism: on join the host sends a Model snapshot (the Model is a Schema; chunk it over the channel); after every tick the host broadcasts the number of sim steps taken and guests run the same steps; a typed or spoken command anywhere is sent to the host as an `AtcCommand`, executed there, appended to the command log and broadcast, and applied by every peer from the broadcast; pause, rate, arrivals, scenario and position changes travel the same way, the last two followed by a fresh snapshot. Peers replay the same events, so logs match and each peer hears the pilots with its own voice settings. Implementation: a `Session` service around Trystero (event stream in, send effect out, wired like the speech and recognition streams), a `session` Model field (solo | host | guest, room, peers, status), the local tick off in guest mode, a Session button in the header with a room code and a shareable deep link. If the host leaves, the session ends (handing the clock to another peer is a later refinement). Verify first with two tabs on one machine, then across real networks.

## 5. Behavioural spec (what `legacy/app.js` does today)

Units: positions are `[lon, lat]`; distances in **feet** on the ground (`FT_LAT = 364000`, `FT_LON = FT_LAT·cos(lat)`), **nautical miles** on the radar (`60·cos(lat)` per degree lon). Sim step `0.1 s`; rate 1–8; a wall-clock loop catches up at most 40 steps per timer tick so a throttled background tab doesn't slow the sim.

**Graph.** Merge vertices within 100 ft (grid-bucketed). Edges named by feature; runway edges after taxiway edges. Runway designators map to node chains (`"12R-30L"` gives `12R` = chain, `30L` = reversed). Taxiway name → node set (runway names excluded). Gates and spots attach to the nearest node of the largest connected component. Hold node for a runway end = first non-runway neighbour found walking the chain from that threshold.

**Routing.** A* with runway-edge penalty 6000 ft; when the controller named taxiways, non-named edges cost `w·1.5 + 380`. Destination for `TAXI` = farthest node of the last named taxiway; for `RWY` = hold node; for a gate/spot = its node. Pushback routes with penalty 9e5 so nothing pushes across a runway. Route readback summary: merge runs; absorb a run < 1400 ft flanked by the same name; drop runs < 300 ft when the route has more than two; group consecutive taxiways so the voice pauses between them.

**Ground physics.** Taxi 16 kt, 9 kt when the next turn exceeds 32°, pushback 4 kt. Accelerate 5 kt/s, decelerate 8 kt/s (14 when holding). Conflict: another moving aircraft within 340 ft inside a ±38° cone ahead; slow to 7 kt, stop under 180 ft; `GIVEWAY` clears when the other is beyond 420 ft; `BREAK` ignores conflicts 15 s. Aircraft hold short automatically at the first runway edge on the path not yet cleared; `CROSS` clears that runway and re-arms the next. `HOLD`/`RES`; `TAXIALL` resumes all held. Arrival at path end: `PUSH`→ready to taxi; gate → parked; runway → holding short; `LUAW` flag → lined up.

**Takeoff and flight.** `CTO` from the hold or from line-up; accelerate 6 kt/s (props 4), rotate at Vr 135 (props 65), roll cap 150. Airborne: fly runway heading, climb 2500 fpm (props 1000) to the airport's `init.jet`/`init.prop` altitude (else 5000), accelerate 3 kt/s to 250 (props 140), decelerate 2 kt/s, turn 3°/s (`TL`/`TR` force direction), descend at 0.6× climb rate. Prop detection by type-code regex (C1xx/C2xx, PA, BE, SW, AT4/7, DH8, SF34, C208, PC12, TBM, SR2x, DA4x, …). Remove the aircraft 20 s after `CD` (handoff) or beyond 16 nm from the radar centre, with a log line.

**Arrivals.** On final at 140 kt, altitude = distance·318 ft (3°), path = runway chain from threshold. Local position: appear at 6 nm, check in ("Minneapolis Tower, Delta ten forty-seven, six mile final, runway three zero right", tower radio name from facility data), need `CTL` or go around at 1 nm; Ground: appear at 3 nm and land unaided. `GA`/go-around: climb runway heading to max(3000, pattern + 1500) at 160 kt. Landed once past the threshold (path leg ≥ 1); roll out decelerating 9 kt/s to 19 kt, then exit at the nearest non-runway node and taxi to a random gate (parks on arrival). Arrival generator: every 70–110 s on the scenario's generator runways (else any runway), weighted by the airport's `trainingAircraftSets`, fallback GA fleet. Arrivals are tracked on arrival.

**Scenario loading.** `P` at a gate (parked, heading from map). `R` holding short: hold node, queued `q·260 ft` back along threshold→hold bearing, facing the runway. `F` on final at `nm`. Spawn delay `d`: hidden from scopes and radar, strip shows "pending +Ns" at the bottom, commands refused ("not on frequency yet"), announced when it comes on frequency. Airborne-start aircraft are counted, not loaded. Squawk assigned `1000 + rand·6000`, transponder standby until airborne.

**Radar (STARS).** Centre = STARS area visibility centre for the airport, else tower location, else map centroid. Default 15 nm range, rings every 5 nm, runways drawn, video maps from `stars.def` (first 4) plus always-visible ones; MAPS picker lists the DCB group then the rest. One return per sim second with a 5-point trail. Visible states: AIRB, FINAL, ROLLOUT, TKOF above 40 kt; never pending. Untracked: beacon code + altitude (hundreds, 3 digits). Tracked (`TRACK`/`IC`): callsign (prefix `H/` after `CD`), `alt3 spd2` (e.g. `017 25`), scratchpad = first 3 letters of the SID, else the runway for arrivals/go-arounds, else the type. Colours: untracked ink-2, tracked green, handoff accent. Click selects the nearest target within 4 % of view width.

**Commands** (callsign prefix or suffix match must be unique; a leading callsign selects). Ground: `PUSH [twy]`, `TAXI path [HS pt]` (a gate/spot may end the path), `RWY rw [TAXI] path [HS pt]`, `HS pt`, `CROSS [rw]`, `RES`, `HOLD`, `BREAK`, `GIVEWAY|GW cs`, `TAXIALL`. Tower: `LUAW`, `CTO`, `EXIT [twy]`, `CTL`, `GA`, `CD`, `FH hdg`, `TL hdg`, `TR hdg`, `CM alt` (feet, hundreds if ≤ 450, or `FLnnn`), `TRACK|IC`, `DROP|DT`. Transponder: `SQ code`, `SN`, `SS`, `ID` (4 s). `SAY gate|type|rwy`, `DEL`, `PAUSE`, `UNPAUSE`, `SIMRATE 1-8`. Unknown text goes to the AI translator when a key is set, else an error line.

**Phraseology.** Log shows written forms; voice gets spoken forms. Runways: digits + left/right/center ("three zero left"; `"12R-30L"` → both ends). Taxiways, gates, spots: ICAO alphabet, digits as words, `niner`; names of 5+ letters spoken as words (ALLEY). Frequencies: digits, "point", trailing zeros dropped. Squawks and headings digit by digit. Altitudes: "five thousand", "one seven thousand five hundred", FL at/above 18000 ("flight level two three zero"). Callsigns: telephony table (DAL Delta, AAL American, UAL United, SWA Southwest, SKW SkyWest, EDV Endeavor, RPA Brickyard, ENY Envoy, JBU JetBlue, SCX Sun Country, ASA Alaska, NKS Spirit, FFT Frontier, FDX FedEx, UPS UPS, EJA ExecJet, LXJ Flexjet, JIA Blue Streak, ASH Air Shuttle, QXE Horizon, AWI Wisconsin, GJS Lindbergh, PDT Piedmont, CPZ Compass, ACA Air Canada, JZA Jazz, WJA WestJet, BAW Speedbird, DLH Lufthansa, AFR Air France, KLM KLM, UAE Emirates, ICE Ice Air, AAY Allegiant, HAL Hawaiian, MXY Breeze, VRD Redwood, AMX Aeromexico, VIV Viva, VOI Volaris, CFG Condor, VIR Virgin, ABX Abex, GTI Giant, ATN Air Transport, CKS Connie, SWQ Swift, BMJ Bemidji, MTN Mountain, LYM Key Lime, JTL Jet Linx) with **combined** flight numbers: 1047 "ten forty-seven", 1992 "nineteen ninety-two", 894 "eight ninety-four", 1004 "ten zero four", 1200 "twelve hundred", 800 "eight hundred", 52 "fifty-two"; N-numbers spelled. Unknown 3-letter prefixes spelled. Sim pilot lines end with the callsign; check-ins and model readbacks are spoken as written. While an AI-translated transmission executes, per-command pilot lines are suppressed and only the model's readback is logged and spoken.

**AI translation.** System prompt: airport name/id, position label, `COMMANDS` reference, runways and taxiways with spoken forms, gates, departure frequency, a phraseology-to-command table (see `legacy/app.js` `buildPrompt`), audio notes when the input is a recording, readback rules. Reply JSON: `transcript` (audio only), `callsign` (must be in the roster or null), `commands[]`, `readback` (written), `spoken` (fully spelled out). Fallback spoken converter if `spoken` is missing. Roster excludes pending aircraft; telephony line lists only prefixes on frequency.

**Audio.** PTT: on-screen button (pointer capture) or Space when focus is not in a text field and no dialog is open; Escape blurs the command box. Recording via MediaRecorder → decode → resample to 16 kHz mono 16-bit WAV → base64. Under 0.4 s is ignored. Without a key: browser SpeechRecognition, result treated as typed. TTS engines: browser `speechSynthesis` (per-callsign voice/rate/pitch by hash) or OpenRouter speech (mp3 → Web Audio; queue plays one at a time, fetch ahead, cache keyed by model|voice|text up to 200; radio effect = highpass 320 Hz, lowpass 3000 Hz, tanh(2.2) waveshaper, compressor −28 dB 8:1, gain 1.25; on failure fall back to the browser voice and log once). Voice picking: English filter by name pattern, then a "vanity" blacklist (whisper, sing, upset, sad, angry, santa, girl/boy, passionate, warrior, queen, anime, …; emotion suffixes keep only `_neutral`); the picker hides the rest and says how many.

**UI.** Header: brand with position dropdown (Ground gold `--amber`, Local purple `#b388ff` via `--accent`/`--accent-ink`), ARTCC/airport/scenario selects, Commands, Settings, clock, Running/Paused, rate, Arrivals, pane switch (ASDE-X / Both / STARS, Local only). Scope legend, HUD, zoom bar. Strips: callsign + state; second line SID (accent) or STAR (cyan) or VFR or "no SID", type, gate/runway, altitude for airborne, "no CTL", "H/O"/"untracked", destination, pending delay, "behind X"; selected strip expands to the flight plan (rules, full type, dep→dst, FL, speed, SID/STAR/APP tags, route, remarks, squawk). Log: newest first, kinds atc/pilot/sys/err/ai. Command bar: selected callsign, input with mode-specific placeholder, hint (AI on/off), speaker toggle, PTT. Settings: OpenRouter key, chat model (+ Load list), audio model, TTS engine/model/voice/radio, vNAS proxy, Test key, Test voice. Deep links `#APT/scenarioId`. Hold-short amber stays semantic in both accents.

## 6. Data contracts (unchanged by the rewrite)

`catalog/index.json`: `{ built, artccs: [{ id, name, airports: [{ id, name, n, asdex, gates, taxi, stars }] }] }`.

`catalog/airports/{APT}.json` (as the data actually is; `src/domain/catalog.ts` is the schema and `bun run validate-catalog` checks every file):
```
{ id, artcc, name, tower: [lon,lat]|null, asdex: videoMapId|null, twrmap: videoMapId|null, updated,
  init: { jet, prop, pattern }, stars: { host, hostName, tcp: string|null, center: [lon,lat], range,
    maps: [{ id, sid, sn, n, b, av, tdm }], def: [id…], twr?: { cs, name, radio, freq }|null (key omitted when absent),
    dep: {…}|null }|null,
  fleet: [{ a, w, t: [types] }],
  map: { taxi: [{ n, c: [[lon,lat]…] }], rwy: [{ n: "12R-30L", c, thr: string|null, to: string|null }],
         park: { NAME: [lon,lat,hdg] }, spot: {…} },
  scen: [{ id, name, stu: string|null, n, air, gen: [rwys], ac: [{ cs, ty, k: "P"|"R"|"F", at, d, dep: string|null,
           dst: string|null, r, tyf?, rte?, alt?, spd?, rmk?, sid?, star?, app?, q?, nm? }] }] }
```
Scenario aircraft callsigns are not unique across a scenario (ABQ repeats `N2382R`); the loader keeps the first and counts the rest as unplaced.
Coordinates rounded to 6 decimals. SID = first route token matching `^[A-Z]{2,5}\d$` (with optional `.TRANSITION`); STAR = last token by the same rule. Type strings strip the weight prefix and suffix (`H/B744/L` → `B744`). Scenario aircraft keep `airportId || primaryAirportId`.

Settings (localStorage `vgt.settings`): `key, model, audioModel, proxy, tts, ttsEngine, ttsModel, ttsVoice, voice, radio, mode ("ground"|"tower"), view`. Preserve the key names so users keep their settings.

## 7. Working agreements

- `legacy/` is read-only reference. Fix nothing there.
- Every domain rule in section 5 gets a test before the port is considered done; use the MSP catalog file as the fixture (checked in under `test/fixtures/`).
- Prefer small modules with one export surface each; the point of the rewrite is that a fresh thread can read one file and understand it.
- Verify in the browser with the preview tools when a phase touches the UI; the pane blocks the microphone, so audio capture is verified by the user.
- Ask before committing or pushing.
