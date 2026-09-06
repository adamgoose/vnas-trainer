# vNAS Ground Trainer

A static, self-hosted ground-control trainer that runs ATCTrainer's command set on any
vNAS training airport. Pick an ARTCC, an airport and one of the facility's own training
scenarios; aircraft appear at the gates and runways the scenario author placed them, and
taxi along the facility's real training-map centrelines over its ASDE-X pavement.

No server code, no build toolchain, no accounts. Optionally, bring your own OpenRouter
key to say things the way you'd say them on frequency.

```
index.html          the trainer (markup + styles)
app.js              graph builder, simulation, commands, OpenRouter bridge
lib/vnas.mjs        shared vNAS data shaping (Node + browser)
build-catalog.mjs   bakes catalog/ from the vNAS API
proxy-worker.js     optional Cloudflare Worker for live-from-vNAS mode
.github/workflows/  builds the catalog and deploys to GitHub Pages
```

---

## Commands

Select an aircraft (scope or strip list) and type, or lead with a callsign the way
ATCTrainer's CLI does — `1877 PUSH A` matches `DAL1877`.

| Ground | Tower / general |
|---|---|
| `PUSH [taxiway]` | `LUAW` · `CTO` · `EXIT [taxiway]` · `GA` |
| `TAXI {path} [HS {pt}]` | `SQ {code}` · `SN` · `SS` · `ID` |
| `RWY {rw} TAXI {path}` | `SAY {gate\|type\|rwy}` · `DEL` |
| `HS {pt}` · `CROSS` · `RES` · `HOLD` | `PAUSE` · `UNPAUSE` · `SIMRATE {1-8}` |
| `GIVEWAY {acft}` · `BREAK` · `TAXIALL` | |

The **Commands** button in the header has the full reference.

---

## Why there is a build step

vNAS serves two things under `data-api.vnas.vatsim.net`, and they behave differently in
a browser:

| Path | `Access-Control-Allow-Origin` | Reachable from your page |
|---|---|---|
| `/Files/VideoMaps/{ARTCC}/{id}.geojson` (ASDE-X pavement) | `*` | yes |
| `/api/training/airports/{id}/map` (taxiway centrelines, gates) | *(none)* | **no** |
| `/api/training/scenarios/{id}` | *(none)* | **no** |
| `/api/artccs/{id}` (facility names, ASDE-X map ids) | *(none)* | **no** |

So the page can fetch **pavement** live, but not the airport map or the scenarios.
`build-catalog.mjs` runs in Node — where CORS does not apply — and bakes those into
`catalog/`. The GitHub Pages workflow reruns it on every push and weekly on a schedule,
so the deployed site tracks vNAS without committing data to the repo.

```bash
node build-catalog.mjs              # every ARTCC (~30 s, ~4 MB)
node build-catalog.mjs ZMP ZLA      # just these
```

Node 18+ (built-in `fetch`). No dependencies. A full build takes about half a minute.

Current catalog: **23 ARTCCs, 195 training airports, 1,477 scenario placements**
(177 airports have taxiway networks, 47 have ASDE-X pavement).

Airports whose training map has runways but no taxiways (many small fields) are kept:
runway-queue and arrival scenarios still work there, taxi commands do not.

### Live mode (optional)

If you would rather not depend on the catalog, deploy [`proxy-worker.js`](proxy-worker.js)
as a Cloudflare Worker (`npx wrangler deploy proxy-worker.js --name vnas-proxy`), then
paste its URL with `?url=` on the end into **Settings → vNAS proxy URL**. The page then
fetches airports, maps and scenarios straight from vNAS on every load. The worker only
forwards to `data-api.vnas.vatsim.net`. Any CORS proxy that takes the target URL as a
query parameter works the same way.

---

## Plain-English commands (bring your own key)

Off by default. In **Settings**, add an [OpenRouter](https://openrouter.ai/keys) API key
and a model id (the **Load list** button fills a picker with every model OpenRouter
offers). Anything you type that isn't a recognised command is sent to that model with
the airport's taxiways, runways, gates and the current roster, translated into ATCTrainer
commands, run, and read back by the pilot.

The key lives in your browser's `localStorage` and is only ever sent to
`openrouter.ai`, which allows browser requests directly. Fast, cheap models do this job
fine — the prompt is small and the answer is a few lines of JSON.

---

## Run it locally

`fetch` needs a real origin, so `file://` will not work.

```bash
node build-catalog.mjs ZMP
python3 -m http.server 8766
```

Then open <http://localhost:8766>. Deep links work: `#MSP` opens Minneapolis,
`#MSP/01J6D177CXF5670N8XY0YX5PQ7` opens a specific scenario.

---

## Host it on GitHub Pages

1. Push the repo to GitHub.
2. **Settings → Pages → Source: GitHub Actions.**
3. Run the *Build catalog and deploy* workflow once (it also runs on push and weekly).

The workflow builds the catalog inside the runner and uploads the folder as the Pages
artifact, so `catalog/` stays out of git (it is in `.gitignore`). If you would rather
deploy from a branch, run `node build-catalog.mjs`, remove `catalog/` from `.gitignore`,
commit it, and point Pages at the branch root — `.nojekyll` is already there.

Any other static host (Cloudflare Pages, Netlify, S3) works the same way: build, then
serve the folder.

---

## What it simulates

Aircraft move on a graph built in the browser from the training map: vertices within
100 ft are merged into one intersection (the vNAS spec's rule), runways are chains of
nodes, and each gate attaches to the nearest node of the main network. Routing is A*
with a heavy penalty on runway edges, biased toward the taxiways the controller named.
Aircraft hold short of every runway until cleared, follow in trail, and give way at
merges.

Scenario aircraft that start at a gate, on a runway or on final are loaded; aircraft that
start airborne are not (the radar side is out of scope). Arrivals, when switched on, use
the airport's own weighted fleet sets from Data Admin and the runways the scenario's
arrival generators use.

Not simulated: wake turbulence, weather, LAHSO, arrival sequencing beyond a straight-in,
and ERAM/STARS entirely.
