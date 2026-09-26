# Contributing

Bug reports, fixes and features are welcome. For anything larger than a small fix, open an issue first so the approach can be agreed before you write the code.

Security issues: don't open a public issue. See [SECURITY.md](./SECURITY.md).

## Setup

Requires Node 20 or later for development (the package itself supports Node 18+).

```bash
git clone https://github.com/vinitkumargoel/hono-status-monitor.git
cd hono-status-monitor
npm ci
```

## Scripts

| Script | What it does |
|---|---|
| `npm run typecheck` | `tsc -p tsconfig.test.json`: source, tests and examples |
| `npm run lint` | Biome lint |
| `npm test` | Vitest, once |
| `npm run test:coverage` | Vitest with the coverage gate |
| `npm run build` | `tsc` to `dist/`, then `scripts/minify-assets.mjs` |
| `npm run smoke` | Imports the built package by name and exercises both entries (`scripts/smoke.mjs`) |
| `npm run size` | Bundle-size budget for both entries (`scripts/size-check.mjs`) |
| `npm run check:package` | `publint` and `@arethetypeswrong/cli` (ESM-only profile) |
| `npm run check` | All of the above in order: typecheck, lint, test:coverage, build, smoke, size, check:package |
| `npm run smoke:workerd` | Runs the `/edge` build inside workerd via Miniflare with a KV namespace |

Run `npm run check` before opening a PR; CI runs the same steps on Node 20, 22 and 24, then smoke-tests the packed tarball on Node 18, Node 24, Bun and Deno, runs the tests against `hono@4.0.0`, and runs the workerd smoke test.

`smoke:workerd` needs Miniflare, which isn't a dependency:

```bash
npm install --no-save miniflare@4
npm run build
npm run smoke:workerd
```

## Project layout

```
src/
  index.ts             Main entry (Node/Bun): statusMonitor(), picks the full or edge collector by runtime; re-exports
  index-edge.ts        /edge entry: statusMonitor() on the edge collector; no node: imports
  types.ts             Public types: StatusMonitorConfig (all options, with JSDoc), snapshots, StatusStore
  config.ts            Defaults, config merging (undefined means default), numeric sanitizing, logger resolution
  status-factory.ts    Assembles a collector into the public handle: middleware, dashboard and /api/metrics routes, auth guard
  routes.ts            Shared routes: authorize guard, /health, /prometheus, SSE /api/stream broadcaster
  request-tracking.ts  Tracking middleware: mount-path skip, ignorePaths, groupBy: 'route', status detection
  stats-core.ts        Runtime-independent counters: routes (LRU-capped), status codes, errors, percentiles, histograms, health checks
  monitor.ts           Node/Bun collector: CPU, memory, heap, load, event-loop lag, GC, cluster reporting
  monitor-edge.ts      Edge collector: request metrics only, history rolled forward per request, store persistence
  edge-status.ts       Edge status monitor factory (edge collector + status-factory)
  edge-store.ts        Cross-isolate store: persist snapshots, load peers, mergeSnapshots
  cluster.ts           node:cluster / PM2 support: worker detection, IPC aggregation, setupClusterPrimary
  platform.ts          Runtime detection (Node, Bun, Cloudflare, edge)
  dashboard.ts         Node dashboard markup and CSS
  dashboard-edge.ts    Edge dashboard markup and CSS
  dashboard-assets.ts  Shared dashboard CSS and client script (polling, SSE, charts, badge, theme)
  chart-cdn.ts         Pinned Chart.js CDN URLs and their SRI hashes
  security.ts          Baseline headers, CSP nonce, opt-in CSP and framing headers
  format.ts            escapeHtml and Prometheus text exposition
  metrics-utils.ts     Percentiles, defaultNormalizePath, uptime formatting
tests/                 Vitest suites
scripts/               Build, smoke, size and workerd scripts
examples/              Runnable examples per runtime
docs/                  Cookbook and troubleshooting
```

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `perf:`, `ci:`.
- **Tests are required** for fixes and features. A fix should come with a test that fails without it.
- **Coverage gate:** 80% lines, statements and functions, 70% branches (`vitest.config.ts`). `npm run test:coverage` fails below it.
- **Bundle budget:** `scripts/size-check.mjs` bundles each entry as a consumer would (hono external, minified) and fails above its budget. If a change legitimately needs more, raise the budget in the same PR and say why.
- **Keep `/edge` free of `node:` imports.** Everything reachable from `src/index-edge.ts` must run on Workers without `nodejs_compat`. Node-only code goes in `monitor.ts`, `cluster.ts` or `index.ts`. The workerd smoke test fails if the edge bundle imports a `node:` builtin.
- **Dashboard client script:** the browser script in `dashboard-assets.ts` is ES5 inside a template literal (no `let`/`const`, arrow functions or template literals inside it; `${...}` is server-side interpolation). It's opaque to TypeScript and bundlers, so `scripts/minify-assets.mjs` minifies it and the CSS in `dist/` after `tsc`, and checks that the element IDs the script drives are still present. Keep it working without Chart.js (the inline renderer is the fallback).
- **Config options** are documented once, in the JSDoc in `src/types.ts`; update the README options table and `docs/` when you add or change one. New numeric options need a rule in `config.ts`.
- **No breaking changes in 1.x.** New behavior that could affect existing deployments is opt-in.

## Releasing

Releases use [Changesets](https://github.com/changesets/changesets).

1. In your PR, run `npx changeset`, choose the bump (patch, minor, major) and describe the change for users. Commit the generated file in `.changeset/`. Docs-only or internal changes don't need one.
2. When PRs with changesets merge to `main`, the Release workflow opens or updates a "chore: version packages" PR that bumps the version and writes the CHANGELOG entry.
3. Merging that PR runs `npm run check` and publishes to npm with provenance (`npx changeset publish`).

Publishing requires the `NPM_TOKEN` repository secret (an npm automation token with publish rights). The workflow needs `id-token: write` for provenance, which is already configured in `.github/workflows/release.yml`.
