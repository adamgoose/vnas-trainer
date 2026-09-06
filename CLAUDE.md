# vNAS Trainer

Static, self-hosted ATC ground/tower trainer on vNAS training data (GitHub Pages).

**State of the repo:** the app is being rewritten as a Foldkit application on Effect v4; the
brief, decisions, verified facts and behavioural spec are in [docs/REWRITE.md](docs/REWRITE.md).
Read that first. The old working app lives untouched in `legacy/` (served at `/legacy/`) and is
the behavioural reference. Phase 0 (spike) is done; the new app is `src/` (`domain/`, `app/`,
`view/`) with tests under `test/` and the MSP catalog fixture in `test/fixtures/`.

Quick facts:
- vNAS `/api/*` has no CORS, so airports and scenarios are baked into `catalog/` (gitignored, built
  in CI by `scripts/build-catalog.ts`, validated against `src/domain/catalog.ts`). `/Files/*` video
  maps are fetched live. A user-supplied CORS proxy enables live mode (`src/services/vnasData.ts`).
- Run locally: `bun install`, build a catalog (`bun run catalog` for every ARTCC, `bun run catalog ZMP`
  for one; partial builds merge into the existing `catalog/index.json`), then `bun run dev` (Vite).
  For live data instead of the catalog, `bun run proxy` starts a local CORS proxy and Settings →
  vNAS proxy URL `http://localhost:8787/?url=` switches the app to it.
  The legacy app is at `/legacy/` on the same server (`legacy/catalog` is a symlink to `catalog/`).
- Checks: `bun run typecheck`, `bun test`, `bun run validate-catalog`. `bun run build` writes `dist/`
  with `catalog/` and `legacy/` copied in.
- Ask before committing or pushing.
