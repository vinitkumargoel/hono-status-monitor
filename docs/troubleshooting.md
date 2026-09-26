# Troubleshooting

Each entry: symptom, cause, fix. Version 2.0; upgrading from 1.x, see the [migration guide](./migrating-to-2.md).

- [403 on /status](#403-on-status)
- [StatusMonitorConfigError at startup](#statusmonitorconfigerror-at-startup)
- [Dashboard shows zeros or charts are missing](#dashboard-shows-zeros-or-charts-are-missing)
- [Badge says Unauthorized, Stale or Offline](#badge-says-unauthorized-stale-or-offline)
- [The dashboard's own requests show up in the metrics](#the-dashboards-own-requests-show-up-in-the-metrics)
- [/health returns 401, 403 or 503 to probes](#health-returns-401-403-or-503-to-probes)
- [CSP errors on the dashboard](#csp-errors-on-the-dashboard)
- [Dashboard is blank in a cross-origin iframe](#dashboard-is-blank-in-a-cross-origin-iframe)
- [Process doesn't exit, or a test runner reports open handles](#process-doesnt-exit-or-a-test-runner-reports-open-handles)
- [Too many routes / high Prometheus cardinality](#too-many-routes--high-prometheus-cardinality)
- [Edge numbers change between refreshes](#edge-numbers-change-between-refreshes)
- [KV costs or stale fleet numbers](#kv-costs-or-stale-fleet-numbers)
- [Live updates stall behind a proxy](#live-updates-stall-behind-a-proxy)
- [503 "Too many stream clients" on /api/stream](#503-too-many-stream-clients-on-apistream)
- [ERR_REQUIRE_ESM or "require() of ES Module"](#err_require_esm-or-require-of-es-module)
- [Workers build fails on node:os / node:cluster](#workers-build-fails-on-nodeos--nodecluster)
- [Warnings in the logs](#warnings-in-the-logs)

---

## 403 on /status

**Cause.** Since 2.0 the status routes are closed until you configure access. With neither `authorize` nor `publicAccess` set, the dashboard, `/api/metrics`, `/api/stream`, `/health` and `/prometheus` all answer 403 with the text `hono-status-monitor: the status routes are closed until you configure access. …`, and the same message is logged once when the monitor is created.

**Fix.**

- Protect the routes: `statusMonitor({ authorize: (c) => … })`. A falsy return then gives 401 instead.
- Or open them: `statusMonitor({ publicAccess: true })`, or `publicAccess: process.env.NODE_ENV !== 'production'` to open them only in development.
- If your own middleware (basic auth, JWT, an authenticating proxy) already guards the path, set `publicAccess: true`: the monitor can't see that middleware.

A 403 with a different body comes from something else (your auth middleware, a WAF, a proxy).

## StatusMonitorConfigError at startup

**Cause.** An option can't work, so `statusMonitor()` throws instead of falling back to a default as 1.x did. The message lists every problem, one per line, and `err.problems` has them as an array:

```
StatusMonitorConfigError: [hono-status-monitor] Invalid config:
  - pollingInterval must be a number > 0; got NaN
  - path must start with "/"; got "status"
```

**Fix.** Correct each listed option. Common causes:

- `Number(process.env.X)` with the variable unset gives `NaN`. Pass the raw string (numeric strings are accepted) or `undefined` to use the default.
- `path` without a leading `/`.
- `groupBy` other than `'path'` or `'route'`; booleans passed as strings (`'true'`); a `store` or `logger` missing a method.
- `sampleRate` outside 0–1.

## Dashboard shows zeros or charts are missing

**Cause.** The charts use Chart.js from jsDelivr by default. If the CDN is blocked (offline network, corporate proxy, CSP, ad blocker), the dashboard switches to its built-in renderer and logs `[status] Chart.js did not load; using the built-in chart renderer.` in the browser console. All zeros usually means no traffic has been tracked yet, or the middleware isn't registered.

**Fix.**

- Make sure `app.use('*', monitor.middleware)` is registered before your routes. Routes registered before it aren't tracked.
- To avoid the CDN entirely, set `inlineCharts: true` (no external scripts), or self-host Chart.js and point `chartjsUrl` / `chartAdapterUrl` at your copies. A same-origin URL is allowed by the CSP as `'self'`.
- On edge, CPU, memory, heap, load and event-loop lag are always 0 on the dashboard and absent from `/prometheus`: those metrics don't exist there.
- The collector starts on the first request through the middleware or a status route. If you only call `getMetrics()` (a job, a test, the OpenTelemetry bridge), call `monitor.start()` first. After `stop()`, collection stays off until `start()`.
- Check the browser console and network tab for failed `/api/metrics` requests; the badge also reports them (next entry).

## Badge says Unauthorized, Stale or Offline

The badge in the header shows the state of the last update:

| Badge | Meaning | Fix |
|---|---|---|
| Live | Last update succeeded. | – |
| Unauthorized | `/api/metrics` returned 401 or 403. | 401: `authorize` rejected the poll. The page load was allowed but the fetch wasn't: header tokens aren't sent by `fetch` from the page. Use auth the browser sends automatically (cookie, basic auth), or check that `authorize` doesn't depend on something only the page request has. 403: no access is configured; see [403 on /status](#403-on-status). |
| Stale · Ns | Updates were working and have stopped for N seconds. Polls back off up to 30 s; the SSE stream is reconnecting. | Server restarted, network dropped, or a proxy is cutting the stream. It recovers on its own once requests succeed. |
| Offline / Error NNN | No update has ever succeeded. | The server is unreachable from the browser or the route returns an error. Open `<mount>/api/metrics` directly to see the response. |

Polling pauses while the tab is hidden, so a background tab showing Stale is normal.

## The dashboard's own requests show up in the metrics

**Cause.** `config.path` doesn't match where `routes` is mounted. The middleware skips requests under `config.path` (default `/status`); if you mount at `/admin/status` but leave `path` unset, every dashboard poll counts as traffic.

**Fix.** Set `path` to the full request path of the mount, including any `basePath`:

```ts
const monitor = statusMonitor({ path: '/admin/status' });
app.route('/admin/status', monitor.routes);
```

With `new Hono().basePath('/api')` and `app.route('/status', ...)`, use `path: '/api/status'`.

## /health returns 401, 403 or 503 to probes

**401 or 403.** `/health` is behind the same gate as the dashboard: 403 when neither `authorize` nor `publicAccess` is set, 401 when `authorize` rejects the probe. Serve health from a separate route using `monitor.getHealth()`, return `true` from `authorize` for the health path, or set `publicAccess: true` if the whole surface may be public. See [Kubernetes probes](./cookbook.md#kubernetes-probes-with-authorize-set).

**503.** At least one required health check reported `connected: false`, threw, or timed out. The body lists each check. Options:

- Mark non-critical checks `required: false`: `healthChecks: { cache: { check: pingRedis, required: false } }`. They're still shown but don't cause 503.
- A check that takes longer than `healthCheckTimeout` (default 5000 ms) reports down. Lower it (or set a per-check `timeoutMs`) so a hung dependency fails the probe quickly; raise it, or set a per-check `timeoutMs`, for a check that is legitimately slow. `0` disables the timeout.
- Results are cached for up to 1 s, so a recovery can take that long to show.

## CSP errors on the dashboard

**Cause.** `securityHeaders` (on by default since 2.0) sends a nonce-based CSP allowing only the dashboard's own inline script and the Chart.js origin. Anything else is blocked:

- Scripts injected by a proxy or CDN, for example Cloudflare Rocket Loader, Cloudflare Web Analytics / Zaraz auto-injection, or a corporate proxy. Rocket Loader also rewrites script tags, which breaks the nonce.
- A custom `chartjsUrl` that the monitor can't express as a CSP source (not http/https, or containing a backslash). In that case the CSP header is omitted rather than sent in a form that would block your script, so no errors, but also no CSP.
- Browser extensions injecting scripts (harmless; ignore).

**Fix.**

- Turn off Rocket Loader and similar injection for the status path (Cloudflare Configuration Rules or Page Rules), or set `securityHeaders: false`.
- Use `inlineCharts: true` for a dashboard with no external scripts at all.
- Self-host Chart.js on the same origin and set `chartjsUrl` / `chartAdapterUrl` to it.

## Dashboard is blank in a cross-origin iframe

**Cause.** `securityHeaders` (on by default since 2.0) adds `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`. Browsers refuse to render the page inside a frame from another origin (Grafana, Backstage, an internal portal).

**Fix.** Set `securityHeaders: false` for that deployment, or serve both from one origin behind a reverse proxy. Also check that your auth works without custom headers (the iframe can't send them) and that third-party cookies aren't being blocked. See [Grafana embedding](./cookbook.md#grafana-embedding).

## Process doesn't exit, or a test runner reports open handles

**Cause.** The collector starts on the first request (or `start()`). On Node, Bun and Deno that's an interval timer. The timer, the SSE broadcast timer and health-check timeouts are all `unref`'d, so they don't keep a process alive on their own. If a process still hangs, something else holds it open: the HTTP server, an open SSE connection, a database client.

**Fix.**

- Call `monitor.stop()` on shutdown and in test teardown (`afterAll(() => monitor.stop())`).
- Close the HTTP server. On Node, `server.close()` waits for open connections, and an open dashboard keeps an `/api/stream` connection alive indefinitely; call `server.closeAllConnections()` after `close()` to end them.
- Create the monitor once per process or test file, not per test: each monitor runs its own collector once it receives a request.

## Too many routes / high Prometheus cardinality

**Cause.** With the default `groupBy: 'path'`, routes are grouped by `normalizePath`, which collapses numeric ids, UUIDs and 24-hex ObjectIds and keeps the first three path segments. Slugs, usernames and other free-form segments still create one route each. Scanners hitting random URLs add more.

**Fix.**

- `groupBy: 'route'` groups by the Hono route pattern that handled the request (`/users/:id`, `/posts/:slug`), regardless of depth. Requests no route matched fall back to `normalizePath`.
- Provide your own `normalizePath`, optionally building on the exported `defaultNormalizePath`.
- Leave noise out with `ignorePaths: ['/favicon.ico', '/assets/*', /^\/\.well-known\//]`.
- `maxTrackedRoutes` (default 1000) caps routes in memory; least-recently-used routes are evicted along with their histogram series. Lower it to bound Prometheus cardinality.

## Edge numbers change between refreshes

**Cause.** On Workers, Deno Deploy and Vercel Edge, each isolate has its own in-memory counters. Consecutive dashboard requests can land on different isolates, so totals jump around and reset when an isolate is recycled.

**Fix.** Pass a KV namespace, the built-in [Durable Object store](./durable-object-store.md) (`durableObjectStore()` from `hono-status-monitor/durable-object`), or any `StatusStore` as `store`. The dashboard's numbers become a merge across isolates (approximate with KV). Charts remain per-isolate by design. Custom metrics from `counter()` / `gauge()` are never merged. See [Cloudflare Workers](./cookbook.md#cloudflare-workers).

## KV costs or stale fleet numbers

**Cause.** Each active isolate writes one KV entry per `storeWriteInterval` (default 60000 ms). Each dashboard refresh with a cold peer cache does one `list` plus up to `maxPeers` (default 50) reads. KV is eventually consistent, so writes can take about 60 s to be visible elsewhere.

**Fix.**

- Expect fleet numbers to trail by roughly a minute. This is inherent to KV.
- To reduce writes, raise `storeWriteInterval`. Lowering it below 60 s doesn't make KV propagate faster and costs more writes.
- To reduce reads, lower `maxPeers` or raise `pollingInterval` (edge default 5000 ms). Close dashboard tabs you aren't using.
- For strongly consistent aggregation without KV `list` costs, use the built-in Durable Object store: `store: durableObjectStore(env.STATUS_STORE)` from `hono-status-monitor/durable-object`. Its reads see every earlier write, so a shorter `storeWriteInterval` (e.g. 15000) pays off. All isolates share one object, so very large fleets are better on KV. Setup: [Durable Object store](./durable-object-store.md).

## Live updates stall behind a proxy

**Cause.** On Node, Bun and Deno, the dashboard uses Server-Sent Events (`/api/stream`). Proxies that buffer responses (nginx by default, some load balancers) hold the events back, so the dashboard receives nothing or receives updates in bursts. If the stream can't be opened at all, the dashboard falls back to polling `/api/metrics` automatically.

**Fix.** Disable buffering for the stream in nginx:

```nginx
location /status/api/stream {
    proxy_pass http://app;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}
```

On other proxies, turn off response buffering and raise idle timeouts for that path.

## 503 "Too many stream clients" on /api/stream

**Cause.** Open SSE connections are capped per monitor by `maxStreamClients` (default 100). Extra clients get a 503 with `Retry-After: 30`, and their dashboards fall back to polling, so they keep working.

**Fix.** Raise `maxStreamClients` if you really have that many viewers, or find what's opening connections (many tabs, a monitor polling the stream, connections a proxy never closes).

## ERR_REQUIRE_ESM or "require() of ES Module"

**Cause.** The package is ESM-only; there's no CommonJS build.

**Fix.** Use `import` in an ES module (`"type": "module"` or `.mjs` / `.mts`). From CommonJS, load it with a dynamic import:

```js
const { statusMonitor } = await import('hono-status-monitor');
```

Recent Node versions can `require()` ES modules without top-level await, but a dynamic `import()` works on every supported version.

## Workers build fails on node:os / node:cluster

**Cause.** The Node build of the main entry, which imports `node:os`, `node:cluster`, `node:perf_hooks` and friends, ended up in a Workers bundle. Since 2.0 Wrangler (`workerd` condition) and Vercel Edge (`edge-light`) resolve `hono-status-monitor` to the edge build, so this happens only with a bundler that doesn't set those conditions (a custom esbuild/webpack setup), or on 1.x.

**Fix.** Import the edge entry explicitly:

```ts
import { statusMonitor } from 'hono-status-monitor/edge';
```

It exports the same `statusMonitor` factory and types, minus the Node-only APIs (`createMonitor`, `generateDashboard`, cluster helpers). Or add the `workerd` condition to your bundler's conditions.

## Warnings in the logs

- `hono-status-monitor: the status routes are closed until you configure access. …` Printed once when a monitor is created without `authorize` or `publicAccess`. See [403 on /status](#403-on-status).
- `Metric "<name>" reached 200 label combinations; new ones are dropped.` A custom metric's labels come from unbounded data (user ids, raw paths). Use bounded label values.
- `📊 Status monitor started` / `stopped` on Node, Bun and Deno when the collector starts or stops. The edge monitor doesn't log these.

Invalid options no longer produce a warning: they throw; see [StatusMonitorConfigError at startup](#statusmonitorconfigerror-at-startup).

To route these messages elsewhere, pass `logger` (any object with `warn` and `error`, such as a pino or winston instance). `logger: false` silences the monitor entirely, including these warnings.
