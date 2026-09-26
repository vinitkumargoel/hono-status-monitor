# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org/).

## 1.1.1

Hardening and reliability fixes. No public API was removed or changed; everything new is additive.

### Security

- The dashboard now sends a per-response, nonce-based `Content-Security-Policy`, plus `X-Frame-Options: SAMEORIGIN` (`frame-ancestors 'self'`), `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Opt out with `securityHeaders: false`.
- The default Chart.js scripts carry Subresource Integrity hashes and `crossorigin="anonymous"`.
- The theme toggle no longer uses an inline `onclick` handler, so the page works under the nonce CSP.
- Cluster IPC messages are shape-checked before they are merged into the aggregate.
- Prometheus label values have carriage returns stripped as well as newlines.

### Fixed

- **The dashboard no longer freezes when the Chart.js CDN is blocked.** It falls back to the built-in renderer, including when Chart.js loads but its date adapter doesn't.
- **Failed polls are now visible.** The badge shows *Live*, *Stale · Ns*, *Unauthorized* or *Offline* instead of always saying "Polling". Polls are chained (no overlapping requests), back off on failure (up to 30 s), and pause while the tab is hidden.
- **Named `healthChecks` now appear on the dashboard**, one card per check, on Node and edge. When no check is configured the dashboard says so, instead of showing a placeholder "Connected, 0 ms".
- A hung health check no longer stalls `/health` or the dashboard. Checks time out after `healthCheckTimeout` (default 5000 ms) and report as down.
- The Node metrics timer and the SSE timers are `unref`'d, so a monitor no longer keeps a script or test process alive.
- On Deno and Vercel Edge the snapshot's `hostname`/`platform` and the dashboard banner name the actual runtime instead of "Cloudflare Workers".

### Added

- `healthCheckTimeout` and `securityHeaders` options.
- `health` in the `/api/metrics` and `/api/stream` payloads, and `configured` in the health report.
- `defaultNormalizePath` is exported, so a custom `normalizePath` can build on it.
- `Cache-Control: no-store` on every status endpoint.

### Performance

- The error rate is kept as a running total (O(1)) instead of scanning every tracked route; the three route lists come from one pass per snapshot; path normalization is memoised; the middleware computes its mount path once.
- Health reports are shared between concurrent callers and reused for 1 s, so N dashboard tabs or SSE clients cost one round of checks, not N.

### Behavior changes to be aware of

- Numeric options that are below their minimum or not finite are now clamped with a console warning (for example `pollingInterval: 100` becomes 250) instead of being passed through.
- The dashboard's "Database" card is replaced by the per-check health cards. The snapshot's `database` field and the Prometheus `database_*` metrics are unchanged.
- `/health` and the health data on the dashboard can be up to 1 s old.

### Tooling

- CI: typecheck (source and tests), lint, tests with an 80 % coverage gate on Node 20/22/24, a build, and a smoke test of the packed tarball on Node 18, Node 24, Bun and Deno, plus a test run against the lowest supported `hono` (4.0.0).
- `publint` and `@arethetypeswrong/cli` run against the package; `sideEffects: false` is declared; `prepack` rebuilds so a local `npm pack` can't ship a stale `dist/`.
- The unused `peerDependenciesMeta` entry for `@hono/node-server` was removed.

## 1.1.0

Internals were restructured to cut the bundle size (73 KB → 50 KB minified for the main entry, 31 KB for `/edge`). The documented `statusMonitor()` factory is unchanged. If you import internals directly:

- **`createMiddleware` moved** from `middleware.js` to `request-tracking.js`. It is still exported from the package root.
- **The dashboard module split** into `dashboard-assets` (shared CSS + client script), `dashboard` (Node) and `dashboard-edge` (edge). `generateDashboard` and `generateEdgeDashboard` are still exported from the package root.
- **Health-check latency on edge** is measured with `performance.now()` and reported to two decimals, matching Node.
- **Route eviction is now genuinely least-recently-used.** A health check that returns `latencyMs: 0` is reported as `0` instead of being replaced by the measured time.

## 1.0.9

- **`getDatabaseStats` / `database` in the snapshot** reports real pool numbers from your `healthCheck`'s `details.poolSize` / `details.availableConnections`, falling back to `0` instead of the previous hardcoded `10`.
- The exported **`StatusMonitor` type** dropped three members the factory never returned (`start`, `getDashboard`, `config`) and added `getHealth`, `resetStats`, `isEdgeMode`, `routes`.
