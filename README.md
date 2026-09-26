# hono-status-monitor

[![npm version](https://img.shields.io/npm/v/hono-status-monitor.svg?style=flat-square)](https://www.npmjs.com/package/hono-status-monitor)
[![npm downloads](https://img.shields.io/npm/dw/hono-status-monitor.svg?style=flat-square)](https://www.npmjs.com/package/hono-status-monitor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

Real-time monitoring dashboard for **Hono.js** — one middleware, a zero-dependency dashboard, plus **Prometheus**, **health-check** and **SSE** endpoints. Runs on **Node.js**, **Bun**, and **Cloudflare Workers / Edge**.

> **Trusted by the Hono community:** 4,000+ weekly npm downloads and growing.

<img width="403" alt="dashboard" src="https://github.com/user-attachments/assets/f793b5f0-a10e-4699-98ab-b4708703d024" />

## Features

- **Live metrics** — CPU, memory, heap, load, response time, RPS, event-loop lag (real `perf_hooks` histogram) + GC stats.
- **Analytics** — P50/P95/P99 latency, top / slowest / error routes, status-code breakdown, recent errors.
- **Endpoints** — HTML dashboard (live over SSE on Node/Bun), JSON API, **`/prometheus`** scrape with a per-route latency histogram, **`/health`** (200/503), **`/api/stream`** SSE.
- **Route grouping by Hono pattern** (`/users/:id`), path exclusion, sampling.
- **Auth hook, alert callbacks, named health checks (required or optional, with timeouts), accessible dashboard with OS-aware dark mode, cluster (PM2) aggregation, edge fleet aggregation via KV.**
- **Safe by default** — route paths are HTML-escaped (no stored XSS), route map is LRU-capped (no unbounded memory growth); optional nonce CSP.

More: [runtime cookbook](./docs/cookbook.md) · [troubleshooting](./docs/troubleshooting.md) · [examples](./examples) · [changelog](./CHANGELOG.md)

## Runtime support

| Runtime | Import | Server | Metrics |
|---|---|---|---|
| Node.js | `hono-status-monitor` | `@hono/node-server` | Full system + request |
| Bun | `hono-status-monitor` | `Bun.serve` | Full system + request |
| Cloudflare Workers | `hono-status-monitor/edge` | runtime default | Request-only (no CPU/mem/heap) |
| Deno | `npm:hono-status-monitor/edge` | `Deno.serve` | Request-only |
| Vercel Edge / Next.js | `hono-status-monitor/edge` | `hono/vercel` | Request-only |

Recipes for each: [docs/cookbook.md](./docs/cookbook.md).

## Install

```bash
npm install hono-status-monitor          # + npm install @hono/node-server for Node
```

The package is **ESM-only** (`"type": "module"`, no CommonJS build). From CommonJS, load it with `await import('hono-status-monitor')`.

## Quick start (Node.js / Bun)

```typescript
import { Hono } from 'hono';
import { serve } from '@hono/node-server';      // omit for Bun
import { statusMonitor } from 'hono-status-monitor';

const app = new Hono();
const monitor = statusMonitor();

app.use('*', monitor.middleware);               // must be first — tracks all requests
app.route('/status', monitor.routes);           // mount dashboard + endpoints
app.get('/', (c) => c.text('Hello World!'));

serve({ fetch: app.fetch, port: 3000 });        // or Bun.serve({ fetch: app.fetch, port: 3000 })
// → dashboard at http://localhost:3000/status
```

> If you mount at a non-default path, set `path` to match (e.g. `statusMonitor({ path: '/mystatus' })`) so the dashboard's own polling isn't counted as traffic.

## Cloudflare Workers / Edge

Use the `/edge` entry (zero Node.js deps):

```typescript
import { Hono } from 'hono';
import { statusMonitor } from 'hono-status-monitor/edge';

const app = new Hono();
const monitor = statusMonitor({ pollingInterval: 3000 });
app.use('*', monitor.middleware);
app.route('/status', monitor.routes);
export default app;
```

Edge exposes request metrics only (CPU/memory/heap/event-loop/load and the SSE stream are unavailable). Each isolate keeps its own counters.

The bare `hono-status-monitor` specifier still resolves to the main (Node) entry on every runtime, exactly as in 1.0.x — Workers using `nodejs_compat` that rely on it keep the same behavior. Import `/edge` to get the smaller, Node-free build.

### Bundle size

Roughly 47 KB minified (17 KB gzipped) for a Worker using the `/edge` entry, hono excluded. CI enforces a size budget on both entries. The dashboard markup is loaded through a dynamic `import()`, so bundlers with code splitting turned on keep it out of the entry chunk. See [docs/bundle-size-report.md](./docs/bundle-size-report.md) for the 1.1.0 size work.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /status` | Dashboard HTML |
| `GET /status/api/metrics` | `{ snapshot, charts, health? }` JSON (`health` only when checks are configured) |
| `GET /status/api/stream` | SSE stream of the same JSON (Node/Bun only) |
| `GET /status/health` | `{ status, configured, uptime, timestamp, checks }` — **200** if all checks pass, **503** if degraded |
| `GET /status/prometheus` | Prometheus/OpenMetrics text (disable via `prometheus: false`) |

All endpoints send `Cache-Control: no-store`. `/health` results are shared between concurrent callers and reused for up to 1 s; the copy sent to dashboard polls for up to 5 s.

## Configuration

```typescript
statusMonitor({
  path: '/status',              // mount path (keep in sync with app.route)
  title: 'My App Status',
  alerts: { cpu: 80, memory: 90, responseTime: 500, errorRate: 5, eventLoopLag: 100 },

  // Fired once on each OK <-> breached transition (wire to Slack/webhooks)
  onAlert: (e) => console.warn(`${e.metric} ${e.active ? 'ALERT' : 'recovered'} @ ${e.value}`),

  // Guard the whole /status surface; falsy return => 401
  authorize: (c) => c.req.header('x-admin-token') === process.env.ADMIN_TOKEN,

  // One or many named health checks (surfaced on /health and the dashboard)
  healthChecks: {
    mongo: async () => ({ connected: mongoose.connection.readyState === 1, latencyMs: 2 }),
    redis: async () => ({ connected: await redis.ping() === 'PONG', latencyMs: 1 }),
  },
  healthCheckTimeout: 3000,     // a hung check reports "down" instead of stalling /health (off by default)
});
```

### All options

| Option | Type | Node default | Edge default | Notes |
|---|---|---|---|---|
| `path` | `string` | `'/status'` | `'/status'` | Where you mount `routes`. Requests under it aren't counted as traffic. |
| `title` | `string` | `'Server Status'` | `'Server Status'` | Dashboard heading and `<title>`. |
| `pollingInterval` | `number` (ms) | `1000` | `5000` | Dashboard refresh; also the SSE push interval (at least 250). |
| `updateInterval` | `number` (ms) | `1000` | `5000` | Metrics sampling. On edge, history rolls forward on requests at this cadence. |
| `retentionSeconds` | `number` | `60` | `60` | Chart history window. |
| `maxRecentErrors` | `number` | `10` | `10` | Errors kept in memory. |
| `maxRoutes` | `number` | `10` | `10` | Length of the top / slowest / error route lists. |
| `maxTrackedRoutes` | `number` | `1000` | `1000` | Hard cap on distinct routes in memory; least-recently-used are evicted. |
| `alerts` | `{ cpu, memory, responseTime, errorRate, eventLoopLag }` | `80, 90, 500, 5, 100` | same | Thresholds. Only `responseTime` and `errorRate` can fire on edge. |
| `onAlert` | `(event) => void` | – | – | Called on each OK ↔ breached transition. |
| `authorize` | `(c) => boolean \| Promise<boolean>` | – | – | Guards every status route; falsy or throwing → 401. |
| `healthCheck` | `() => Promise<HealthCheckResult>` | – | – | Single check, reported as `database`. Its `details.poolSize` / `availableConnections` feed the snapshot's `database` field. |
| `healthChecks` | `Record<string, fn \| { check, required?, timeoutMs? }>` | – | – | Named checks, run in parallel. Takes precedence over `healthCheck` for `/health`. A check with `required: false` is shown but never makes `/health` 503. |
| `healthCheckTimeout` | `number` (ms) | `0` (none) | `0` (none) | Per-check timeout; a timed-out check reports down. Becomes 5000 in 2.0. |
| `normalizePath` | `(path) => string` | see below | same | Groups paths into routes. |
| `groupBy` | `'path' \| 'route'` | `'path'` | `'path'` | `'route'` groups by the Hono route pattern that handled the request (`/users/:id`); unmatched requests fall back to `normalizePath`. |
| `ignorePaths` | `(string \| RegExp)[] \| (path) => boolean` | `[]` | `[]` | Requests left out entirely. Strings match exactly, or as a prefix when they end in `/*`. |
| `sampleRate` | `number` (0–1) | `1` | `1` | Fraction of requests whose timing is recorded. Counts, status codes and errors always include every request. |
| `logger` | `{ log, warn, error } \| false` | `console` | `console` | Where the monitor's own messages go; `false` silences them. |
| `maxStreamClients` | `number` | `100` | – | Concurrent `/api/stream` connections; extra clients get 503 and the dashboard polls instead. |
| `prometheus` | `boolean` | `true` | `true` | Expose `/prometheus`. |
| `prometheusPrefix` | `string` | `'hono'` | `'hono'` | Metric name prefix. |
| `prometheusHistogram` | `boolean` | `false` | `false` | Add the per-route `http_request_duration_seconds` histogram. |
| `chartjsUrl` / `chartAdapterUrl` | `string` | jsDelivr, pinned + SRI | same | Self-host Chart.js (a relative URL is allowed by the CSP as `'self'`). |
| `inlineCharts` | `boolean` | `false` | `false` | Built-in renderer, no external scripts at all. |
| `securityHeaders` | `boolean` | `false` | `false` | Nonce CSP + same-origin framing on the dashboard (see [Security](#security)). Becomes the default in 2.0. |
| `clusterMode` | `boolean` | auto-detected | – | Aggregate PM2 / `node:cluster` workers. |
| `store` | `StatusStore` | – | – | KV-shaped store for aggregating edge isolates (see below). No-op on Node. |
| `instanceId` | `string` | – | random | Stable id for this isolate in `store`. |
| `storeWriteInterval` | `number` (ms) | – | `60000` | How often an isolate writes to `store`. |
| `maxPeers` | `number` | – | `50` | Upper bound on peer snapshots read from `store` per refresh. |
| `socketPath` | `string` | – | – | **Deprecated**, ignored. |

Numeric options that can't work (zero or negative intervals and caps, `NaN`, non-numeric strings) fall back to their default with a console warning. `undefined` means "use the default", and numeric strings such as `'120'` are accepted.

**Default path normalization** collapses UUIDs to `:uuid`, 24-hex ObjectIds and all-digit segments to `:id`, then **keeps the first three path segments** — `/api/v1/users/42/posts` is tracked as `/api/v1/users`. Pass `normalizePath` to change that; you can build on the default:

```typescript
import { defaultNormalizePath } from 'hono-status-monitor';
statusMonitor({ normalizePath: (p) => p.startsWith('/api/v2/') ? p.replace(/\/\d+/g, '/:id') : defaultNormalizePath(p) });
```

### The returned handle

`statusMonitor()` returns `{ middleware, routes, getMetrics(), getCharts(), getHealth(), trackRateLimit(blocked), resetStats(), stop(), initSocket(), monitor, isEdgeMode }`. `initSocket()` is a no-op kept for compatibility; `monitor` is the underlying instance.

Collection starts when `statusMonitor()` is called. The Node collector's timer is `unref`'d, so it never keeps a process alive on its own; call `stop()` to release it explicitly.

### Exports

| Export | Entry | Purpose |
|---|---|---|
| `statusMonitor` (also default export, `statusMonitorEdge`) | both | The factory above. |
| `createMonitor` / `createEdgeMonitor` | main / both | Lower-level collectors without routes. |
| `createMiddleware`, `createRequestTrackingMiddleware` | both | Tracking middleware for a collector. |
| `generateDashboard` / `generateEdgeDashboard` | main / both | Render the dashboard HTML yourself. |
| `toPrometheus`, `escapeHtml` | both | Formatters. |
| `defaultNormalizePath` | both | The default route normalizer. |
| `mergeSnapshots`, `generateInstanceId` | both | Edge cross-isolate helpers. |
| `detectPlatform`, `isNodeEnvironment`, `isBunEnvironment`, `isCloudflareEnvironment`, `isEdgeEnvironment`, `getPlatformInfo` | both | Runtime detection. |
| `setupClusterPrimary`, `isClusterWorker`, `isClusterMaster`, `getWorkerId`, `createClusterAggregator` | main | PM2 / cluster support. |
| Types: `StatusMonitorConfig`, `MetricsSnapshot`, `ChartData`, `HealthReport`, `HealthCheckResult`, `StatusStore`, … | both | |

### Aggregating edge isolates

Each Workers isolate keeps its own counters. Pass a KV namespace (or anything implementing `get` / `put` / `list`) as `store` and the dashboard shows an approximate fleet-wide view:

```typescript
statusMonitor({ store: env.STATUS_KV, storeWriteInterval: 60_000 });
```

Each isolate writes its numbers from the request path (through `executionCtx.waitUntil`) once per `storeWriteInterval`, and peer snapshots are cached between writes, so a dashboard poll costs no KV reads most of the time. Counts are summed across isolates; response time and error rate are weighted by traffic. Charts stay per isolate. KV is eventually consistent, so expect the fleet view to lag by up to a minute. See the [cookbook](./docs/cookbook.md) for a complete Worker.

## Prometheus / Grafana

Scrape `/status/prometheus` — emits `<prefix>_cpu_percent`, `_heap_used_bytes`, `_rps`, `_response_time_p95_ms`, `_requests_total`, `_http_responses_total{code="..."}`, etc., plus, with `prometheusHistogram: true`, a latency histogram per route:

```
hono_http_request_duration_seconds_bucket{method="GET",route="/users/:id",status="200",le="0.05"} 1832
```

Use it for quantiles across instances — the `_p95_ms` gauges are per process and can't be averaged:

```promql
histogram_quantile(0.95, sum by (le, route) (rate(hono_http_request_duration_seconds_bucket[5m])))
```

The histogram is opt-in (`prometheusHistogram: true`) because it adds up to 14 series per route and status. Pair it with `groupBy: 'route'` so the `route` label has bounded cardinality.

```yaml
scrape_configs:
  - job_name: my-app
    metrics_path: /status/prometheus
    static_configs: [{ targets: ['localhost:3000'] }]
```

## Rate-limit tracking

```typescript
if (isRateLimited) { monitor.trackRateLimit(true); return c.text('Too many requests', 429); }
monitor.trackRateLimit(false);
```

## PM2 / Cluster mode

Metrics aggregate across workers with **no Redis**. In your cluster entry file, call `setupClusterPrimary()` in the primary — it relays worker metrics to every worker and respawns dead ones:

```typescript
import cluster from 'node:cluster';
import * as os from 'node:os';
import { setupClusterPrimary } from 'hono-status-monitor';

if (cluster.isPrimary) {
  for (let i = 0; i < os.cpus().length; i++) cluster.fork();
  setupClusterPrimary();                 // relay + auto-respawn
} else {
  await import('./server.js');           // your app (auto-detects worker mode)
}
```

```bash
pm2 start cluster.js --name my-app       # single PM2 instance; the script forks workers
```

Don't use `pm2 start app.js -i max` directly — isolated instances can't share IPC.

## Security

The dashboard exposes hostname, PID, routes and errors. Protect it in production:

```typescript
// Built-in guard — compare secrets in constant time (works on every runtime)
import { timingSafeEqual } from 'hono/utils/buffer';
const token = process.env.STATUS_TOKEN;
statusMonitor({
  // Reject outright when the secret is unset — timingSafeEqual('', '') is true.
  authorize: (c) => !!token && timingSafeEqual(c.req.header('x-token') ?? '', token),
});

// …or Hono basic-auth
import { basicAuth } from 'hono/basic-auth';
app.use('/status/*', basicAuth({ username: 'admin', password: process.env.STATUS_PASSWORD! }));
app.route('/status', monitor.routes);
```

Route paths are HTML-escaped before rendering, so hostile request paths can't inject scripts into the dashboard.

**Headers.** Every status response sends `Cache-Control: no-store`, and the dashboard also sends `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. The default Chart.js scripts carry Subresource Integrity hashes, and if the CDN is unreachable the dashboard falls back to its built-in renderer.

Set `securityHeaders: true` to add a per-response nonce-based `Content-Security-Policy` (scripts limited to the dashboard's own inline script and the Chart.js origin) and same-origin framing (`frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`). It's off by default in 1.x because it blocks embedding the dashboard in a cross-origin iframe (Grafana, Backstage…) and scripts injected by proxies; it becomes the default in 2.0. If a custom `chartjsUrl` can't be expressed as a CSP source, the CSP is omitted rather than sent in a form that would block it.

The status surface is **public by default** — anyone who can reach the mounted path gets the dashboard, `/api/metrics`, `/api/stream`, `/prometheus` and `/health`. Set `authorize` (or front it with your own auth) in any environment where that's not acceptable. Note that when `authorize` is set it also gates `/health`; if a load balancer or k8s liveness probe hits `/health` unauthenticated, either exempt that path in your own middleware or point the probe at an unguarded route.

## Upgrading

See [CHANGELOG.md](./CHANGELOG.md). 1.1.1 and 1.2.0 remove no public API and keep every existing default; the things you might notice are listed under *Behavior changes to be aware of* in each release.

## Requirements

Node ≥ 18 · Bun ≥ 1.0 · Hono ≥ 4.0 · `@hono/node-server` ≥ 1.0 (Node only).

## License

MIT © [Vinit Kumar Goel](https://github.com/vinitkumargoel)

---

Pairing app telemetry with external risk awareness? ThreatFrontier tracks [emerging CVEs and exploitation trends](https://threatfrontier.com/) — a solid [cybersecurity news source](https://threatfrontier.com/) for security teams.
