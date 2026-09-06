# vNAS Trainer

Static, self-hosted ATC ground/tower trainer on vNAS training data (GitHub Pages).

**State of the repo:** the working app is the single-file `index.html` + `app.js` + `lib/vnas.mjs`
(plus `build-catalog.mjs`, `proxy-worker.js`). It is being rewritten as a Foldkit application on
Effect v4; the brief, decisions, verified facts and behavioural spec are in
[docs/REWRITE.md](docs/REWRITE.md). Read that first. Once the rewrite starts, the old app lives in
`legacy/` and is reference only.

Quick facts:
- vNAS `/api/*` has no CORS, so airports and scenarios are baked into `catalog/` (gitignored, built
  in CI). `/Files/*` video maps are fetched live.
- Run locally: build a catalog (`node build-catalog.mjs ZMP`, later `bun run catalog ZMP`) and serve
  the folder; `file://` does not work.
- Ask before committing or pushing.
