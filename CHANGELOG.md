# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org/).

## 2.0.0

Secure defaults, fail-fast config, custom metrics and an OpenTelemetry bridge. **Read the [migration guide](./docs/migrating-to-2.md)** before upgrading: most apps need one new option (`authorize` or `publicAccess`).

### Breaking

- **The status routes are closed by default.** The dashboard, `/api/metrics`, `/api/stream`, `/health` and `/prometheus` answer 403 with an explanatory text body unless `authorize` or the new `publicAccess: true` is set, and the monitor logs one warning at construction when neither is. `/health` is included, so point load-balancer probes at a separate route, allow them in `authorize`, or set `publicAccess`. This replaces the 1.2 warning that only fired in production.
- **`securityHeaders` defaults to `true`** (nonce CSP and same-origin framing). Set `false` to embed the dashboard cross-origin.
- **`healthCheckTimeout` defaults to 5000 ms.** `0` disables it.
- **Invalid config throws `StatusMonitorConfigError`** (exported from both entries, with `problems: string[]`), listing every problem at once, instead of warning and using the default. Checked: numeric ranges, function/boolean/string types, `path` starting with `/`, `groupBy`, `ignorePaths`, `healthChecks` entries, `store` and `logger`. Numeric strings are still accepted.
- **Lazy start.** Creating a monitor has no side effects. Collection starts on the first request through `middleware` or a status route, or on `start()`. `stop()` stays in effect until `start()`.
- **Removed:** `initSocket()` (handle and monitor), the monitor's `io` getter, the `socketPath` option and `DashboardProps.socketPath`, and `getPlatformInfo().hasWebSocketSupport`.
- **Platform detection:** `detectPlatform()` can return `'deno'`, and checks bun → deno → cloudflare → `EdgeRuntime` → node, so Workers with `nodejs_compat` are detected as `'cloudflare'`. `isEdgeEnvironment()` is `false` on Deno, which now gets the full Node-compatible monitor from the main entry.
- **Entry resolution:** the main export has `workerd` and `edge-light` conditions, so `import 'hono-status-monitor'` in Wrangler and Vercel Edge bundles gets the edge build.
- **Node 18 is dropped** (`engines.node >= 20`). The `hono` peer range is `^4.0.0`.
- **Types:** `authorize` takes Hono's `Context`; the handle is `StatusMonitor<M>` with `middleware: MiddlewareHandler` and `routes: Hono`. `statusMonitor()` returns `StatusMonitor<Monitor | EdgeMonitor>` from the main entry and `StatusMonitor<EdgeMonitor>` from `/edge`.
- **Prometheus on edge** no longer emits the always-zero system gauges (`cpu_percent`, `memory_used_bytes`, `memory_percent`, `heap_used_bytes`, `heap_total_bytes`, `load_average`, `event_loop_lag_ms`).

### Added

- **`publicAccess`** option to serve the status routes without `authorize`.
- **Custom metrics:** `monitor.counter(name, help?)` (`.inc(labels?, value = 1)`) and `monitor.gauge(name, help?)` (`.set(value, labels?)`, `.inc(labels?, value)`). Exported on `/prometheus` as `<prometheusPrefix>_<name>` and under `custom` in `/api/metrics` when any are registered. Per instance; names and labels are validated; at most 200 label combinations per metric (warns once).
- **OpenTelemetry bridge:** `registerOtelMetrics(meter, monitor, options)` from `hono-status-monitor/otel`, with no `@opentelemetry/*` dependency. See [docs/opentelemetry.md](./docs/opentelemetry.md).
- **Durable Object store:** `durableObjectStore(namespace)` and `StatusStoreObject` from `hono-status-monitor/durable-object`, a strongly consistent `store` for edge fleet aggregation. See [docs/durable-object-store.md](./docs/durable-object-store.md).
- `handle.start()`, `isDenoEnvironment()`, and JSDoc on the `StatusMonitor` handle.

### Changed

- The edge monitor's `start()` / `stop()` no longer log.
- Deno uses the full monitor (system metrics, SSE) from the main entry; `/edge` still works there with request-only metrics.

## 1.2.0

New, opt-in capabilities and a better dashboard. Nothing is removed, and every option defaults to the 1.1.x behaviour.

### Added

- **`groupBy: 'route'`** groups requests by the Hono route pattern that handled them (`/users/:id`, including sub-apps), at any depth. Unmatched requests fall back to `normalizePath`. The default stays `'path'`.
- **`ignorePaths`** leaves requests out entirely: exact strings, `/*` prefixes, RegExps or a predicate.
- **`sampleRate`** (0–1) records a fraction of requests in per-route stats, percentiles and histograms; the total request count, status codes and overall error rate still include every request.
- **`logger`** routes the monitor's own messages; `logger: false` silences them. Config warnings go through it too.
- **`prometheusHistogram: true`** adds `<prefix>_http_request_duration_seconds{method,route,status}` to `/prometheus`, so latency quantiles can be aggregated across instances.
- **Health checks with options:** a `healthChecks` entry can be `{ check, required, timeoutMs }`. `required: false` checks are reported (with `required: false`) but never make `/health` 503; `timeoutMs` overrides `healthCheckTimeout` for that check.
- **`maxStreamClients`** (default 100) caps concurrent `/api/stream` connections; extra clients get 503 and the dashboard polls instead.
- **`maxPeers`** (default 50) caps peer snapshots read from an edge `store`.
- A one-time warning in production (`NODE_ENV=production`) when the status routes are public because `authorize` isn't set. Silence it with `authorize` or `logger`.

### Dashboard

- **Live over SSE on Node and Bun**: one push per interval instead of a request per poll. It falls back to polling when the stream can't be opened, is capped, or delivers nothing within `max(5 s, 3 × pollingInterval)` (e.g. behind a buffering proxy).
- **Accessibility:** WCAG AA colour contrast, 11 px minimum label size, `<main>` and heading structure, labelled charts, `aria-pressed` on the theme toggle, a live region that announces alert changes, visible focus, full route paths on hover. axe reports no WCAG A/AA violations in light or dark mode.
- **Dark mode** follows the OS setting until you choose, is applied before first paint (no white flash), and re-themes the charts when toggled.
- **Time-range selector** (1m / 5m / 15m / 1h) when `retentionSeconds` keeps more than a minute.
- Route and error lists show `maxRoutes` / `maxRecentErrors` rows instead of a fixed 5.

### Improved

- **Edge fleet aggregation actually covers the fleet.** Each isolate now writes its numbers from the request path (via `executionCtx.waitUntil`) instead of only when someone loads the dashboard. Peer snapshots are cached between writes, so a dashboard poll usually costs no KV reads.
- Fleet response time is weighted by each isolate's request rate and the error rate by its request count (previously a plain mean, which let idle isolates skew the figures).
- `/api/stream` computes one snapshot per tick for all connected clients instead of one per client, and its timer only runs while someone is connected.
- Cluster workers send only new chart points over IPC (a full resend every 30 messages), instead of every series in full every second. Deltas are only sent once every peer worker has announced it understands them, so a 1.1.x worker running alongside during a rolling restart keeps receiving full charts, and a full resend goes out whenever a new or restarted peer appears.

### Fixed

- **Cluster aggregation works without `initSocket()`.** Workers only listened for their peers' metrics if the app called `monitor.initSocket()`, which the docs describe as a no-op, so most clustered dashboards showed a single worker. The listener is now registered when the monitor starts and removed by `stop()`; calling `initSocket()` as well is harmless.

### Behavior changes to be aware of

- The tracking middleware now records a route when the request completes rather than when it starts, so in-flight requests no longer show up as zero-count routes.
- With a `store`, peer snapshots with non-finite or negative counts, or non-array route lists, are skipped rather than merged.
- With a `store`, the fleet `responseTime` and `errorRate` are traffic-weighted (see above), so they can differ from 1.1.x.
- The dashboard's colours and label sizes changed for contrast; it now opens `/api/stream` on Node and Bun.

### Tooling

- A jsdom test suite runs the real dashboard client script; the build minifier has unit tests (and now fails the build if an interpolation would be lost); the `/edge` build is smoke-tested inside workerd via Miniflare in CI.
- Releases go through Changesets and a publish workflow with npm provenance; Dependabot keeps dependencies and actions current.
- New docs: [runtime cookbook](./docs/cookbook.md), [troubleshooting](./docs/troubleshooting.md), SECURITY.md, CONTRIBUTING.md, issue and PR templates, and runnable examples for Workers, Deno and Vercel Edge.

## 1.1.1

Hardening and reliability fixes. No public API was removed or changed; everything new is additive, and new protections that could change behaviour for an existing deployment are opt-in.

> 1.1.0 was never published to npm. If you are upgrading from 1.0.9, read the 1.1.0 notes below as well.

### Security

- New `securityHeaders: true` option: a per-response, nonce-based `Content-Security-Policy` and same-origin framing (`frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`) on the dashboard. Off by default in 1.x; on by default in 2.0.
- The dashboard always sends `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- The default Chart.js scripts carry Subresource Integrity hashes and `crossorigin="anonymous"`.
- The theme toggle no longer uses an inline `onclick` handler, so the page works under the nonce CSP.
- Cluster IPC messages are shape-checked before they are merged into the aggregate.
- Prometheus label values have carriage returns stripped as well as newlines.

### Fixed

- **The dashboard no longer freezes when the Chart.js CDN is blocked.** It falls back to the built-in renderer, including when Chart.js loads but its date adapter doesn't.
- **Failed polls are now visible.** The badge shows *Live*, *Stale · Ns*, *Unauthorized* or *Offline* instead of always saying "Polling". Polls are chained (no overlapping requests), back off on failure (up to 30 s), and pause while the tab is hidden.
- **Named `healthChecks` now appear on the dashboard**, one card per check, on Node and edge. When no check is configured the dashboard says so, instead of showing a placeholder "Connected, 0 ms".
- New `healthCheckTimeout` option: a check that takes longer reports as down (with the time waited as its latency) instead of stalling `/health` and the dashboard. Off by default in 1.x; 5000 ms in 2.0.
- The dashboard's own polls no longer hang forever on a request that never answers: each poll is aborted after `max(10 s, 2 × pollingInterval)` and the badge turns *Stale*.
- An explicit `undefined` option value (e.g. `healthCheck: cond ? fn : undefined`) now means "use the default". Previously it replaced the default, which made `/health` report *degraded* with no check configured.
- `resetStats()` no longer lets requests that were in flight at the time leak status codes into the fresh counters.
- The Node metrics timer and the SSE timers are `unref`'d, so a monitor no longer keeps a script or test process alive.
- On Deno and Vercel Edge the snapshot's `hostname`/`platform` and the dashboard banner name the actual runtime instead of "Cloudflare Workers".

### Added

- `healthCheckTimeout` and `securityHeaders` options.
- `health` in the `/api/metrics` and `/api/stream` payloads when checks are configured, and `configured` in the health report.
- `defaultNormalizePath` is exported, so a custom `normalizePath` can build on it.
- `Cache-Control: no-store` on every status endpoint.

### Performance

- The error rate is kept as a running total (O(1)) instead of scanning every tracked route; the three route lists come from one pass per snapshot; path normalization is memoised; the middleware computes its mount path once.
- Health checks are shared between concurrent callers and reused for 1 s (5 s for the copy sent to dashboard polls), so N dashboard tabs or SSE clients cost one round of checks, not N. A single `healthCheck` now runs once per window for both `/health` and the snapshot's `database` field, instead of once each.

### Behavior changes to be aware of

- Numeric options that can't work (zero or negative intervals and caps, `NaN`, non-numeric strings) now fall back to their default with a console warning instead of being passed through. Small-but-valid values and numeric strings are unaffected.
- The dashboard's "Database" card is replaced by the per-check health cards. The snapshot's `database` field and the Prometheus `database_*` metrics are unchanged.
- `/health` can be up to 1 s old, and the health data on the dashboard up to 5 s.
- The collector timers are `unref`'d: a script whose only live handle was the monitor now exits instead of hanging.

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
