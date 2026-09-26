# hono-status-monitor

[![npm version](https://img.shields.io/npm/v/hono-status-monitor.svg?style=flat-square)](https://www.npmjs.com/package/hono-status-monitor)
[![npm downloads](https://img.shields.io/npm/dw/hono-status-monitor.svg?style=flat-square)](https://www.npmjs.com/package/hono-status-monitor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

Real-time monitoring dashboard for **Hono.js** — one middleware, a zero-dependency dashboard, plus **Prometheus**, **health-check** and **SSE** endpoints. Runs on **Node.js**, **Bun**, **Deno**, and **Cloudflare Workers / Edge**.

> **Trusted by the Hono community:** 4,000+ weekly npm downloads and growing.

<img width="403" alt="dashboard" src="https://github.com/user-attachments/assets/f793b5f0-a10e-4699-98ab-b4708703d024" />

> **Upgrading from 1.x?** 2.0 closes the status routes by default (set `authorize` or `publicAccess`), turns on security headers, and throws on invalid config. See the [migration guide](./docs/migrating-to-2.md).

## Features

- **Live metrics** — CPU, memory, heap, load, response time, RPS, event-loop lag (real `perf_hooks` histogram) + GC stats.
- **Analytics** — P50/P95/P99 latency, top / slowest / error routes, status-code breakdown, recent errors.
- **Endpoints** — HTML dashboard (live over SSE on Node/Bun/Deno), JSON API, **`/prometheus`** scrape with a per-route latency histogram, **`/health`** (200/503), **`/api/stream`** SSE.
- **Custom metrics** — your own counters and gauges on `/prometheus` and `/api/metrics`; an **OpenTelemetry** bridge.
- **Route grouping by Hono pattern** (`/users/:id`), path exclusion, sampling.
- **Auth hook, alert callbacks, named health checks (required or optional, with timeouts), accessible dashboard with OS-aware dark mode, cluster (PM2) aggregation, edge fleet aggregation via KV or a Durable Object.**
- **Secure by default** — status routes closed until you configure access, nonce CSP and same-origin framing, HTML-escaped route paths (no stored XSS), LRU-capped route map (no unbounded memory growth), config validated at startup.

More: [migrating to 2.0](./docs/migrating-to-2.md) · [runtime cookbook](./docs/cookbook.md) · [troubleshooting](./docs/troubleshooting.md) · [examples](./examples) · [changelog](./CHANGELOG.md)

## Runtime support

| Runtime | Import | Server | Metrics |
|---|---|---|---|
| Node.js ≥ 20 | `hono-status-monitor` | `@hono/node-server` | Full system + request |
| Bun | `hono-status-monitor` | `Bun.serve` | Full system + request |
| Deno | `npm:hono-status-monitor` | `Deno.serve` | Full system + request |
| Cloudflare Workers | `hono-status-monitor/edge` (or the main entry, see below) | runtime default | Request-only (no CPU/mem/heap) |
| Vercel Edge / Next.js | `hono-status-monitor/edge` (or the main entry) | `hono/vercel` | Request-only |

Recipes for each: [docs/cookbook.md](./docs/cookbook.md).

## Install

```bash
npm install hono-status-monitor          # + npm install @hono/node-server for Node
```

The package is **ESM-only** (`"type": "module"`, no CommonJS build). From CommonJS, load it with `await import('hono-status-monitor')`.

## Quick start (Node.js / Bun / Deno)

```typescript
import { Hono } from 'hono';
import { serve } from '@hono/node-server';      // omit for Bun / Deno
import { timingSafeEqual } from 'hono/utils/buffer';
import { statusMonitor } from 'hono-status-monitor';

const app = new Hono();
const token = process.env.STATUS_TOKEN;
const monitor = statusMonitor({
  // Required: the status routes answer 403 until you set authorize or publicAccess.
  authorize: async (c) => !!token && timingSafeEqual(c.req.header('x-token') ?? '', token),
  // …or, for local development only:
  // publicAccess: process.env.NODE_ENV !== 'production',
});

app.use('*', monitor.middleware);               // must be first — tracks all requests
app.route('/status', monitor.routes);           // mount dashboard + endpoints
app.get('/', (c) => c.text('Hello World!'));

serve({ fetch: app.fetch, port: 3000 });        // or Bun.serve({ fetch: app.fetch, port: 3000 })
// → dashboard at http://localhost:3000/status
```

> If you mount at a non-default path, set `path` to match (e.g. `statusMonitor({ path: '/mystatus', authorize })`) so the dashboard's own polling isn't counted as traffic.

A header token suits API clients and scrapers; a browser can't send it on a page load. For people opening the dashboard, see [Security](#security) for cookie or basic auth.

## Cloudflare Workers / Edge

Use the `/edge` entry (zero Node.js deps):

```typescript
import { Hono } from 'hono';
import { statusMonitor } from 'hono-status-monitor/edge';

type Env = { STATUS_TOKEN?: string };
const app = new Hono<{ Bindings: Env }>();
const monitor = statusMonitor({
  pollingInterval: 3000,
  authorize: (c) => !!c.env.STATUS_TOKEN && c.req.header('x-token') === c.env.STATUS_TOKEN,
});
app.use('*', monitor.middleware);
app.route('/status', monitor.routes);
export default app;
```

Use `timingSafeEqual` from `hono/utils/buffer` for the comparison in production, as in the quick start.

Edge exposes request metrics only (CPU/memory/heap/event-loop/load and the SSE stream are unavailable). Each isolate keeps its own counters; see [Aggregating edge isolates](#aggregating-edge-isolates).

The main entry's `"."` export has `workerd` and `edge-light` conditions, so `import 'hono-status-monitor'` in a Wrangler or Vercel Edge bundle resolves to the same edge build automatically, with or without `nodejs_compat`. Importing `/edge` states it explicitly and also works with bundlers that don't set those conditions.

### Bundle size

Roughly 52 KB minified (18 KB gzipped) for a Worker using the `/edge` entry, hono excluded; the `/otel` and `/durable-object` subpaths add about 2 KB and 4 KB only if you import them. CI enforces a size budget on both entries. The dashboard markup is loaded through a dynamic `import()`, so bundlers with code splitting turned on keep it out of the entry chunk. See [docs/bundle-size-report.md](./docs/bundle-size-report.md) for the 1.1.0 size work.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /status` | Dashboard HTML |
| `GET /status/api/metrics` | `{ snapshot, charts, health?, custom? }` JSON (`health` only when checks are configured, `custom` only when custom metrics are registered) |
| `GET /status/api/stream` | SSE stream of `{ snapshot, charts, health? }` (Node/Bun/Deno only) |
| `GET /status/health` | `{ status, configured, uptime, timestamp, checks }` — **200** if all checks pass, **503** if degraded |
| `GET /status/prometheus` | Prometheus/OpenMetrics text (disable via `prometheus: false`) |

Every endpoint is behind the access gate: **403** with an explanatory text body when neither `authorize` nor `publicAccess` is set, **401** when `authorize` rejects the request.

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
  healthCheckTimeout: 3000,     // a hung check reports "down" instead of stalling /health (default 5000)
});
```

### All options

| Option | Type | Node default | Edge default | Notes |
|---|---|---|---|---|
| `path` | `string` | `'/status'` | `'/status'` | Where you mount `routes`; must start with `/`. Requests under it aren't counted as traffic. |
| `title` | `string` | `'Server Status'` | `'Server Status'` | Dashboard heading and `<title>`. |
| `authorize` | `(c: Context) => boolean \| Promise<boolean>` | – | – | Guards every status route; falsy or throwing → 401. This or `publicAccess` is required for the routes to answer. |
| `publicAccess` | `boolean` | `false` | `false` | Serve the status routes without `authorize`. With neither set, every status route returns 403. Also set it when your own middleware (basic auth, JWT, a proxy) protects the path. |
| `pollingInterval` | `number` (ms) | `1000` | `5000` | Dashboard refresh; also the SSE push interval (at least 250). |
| `updateInterval` | `number` (ms) | `1000` | `5000` | Metrics sampling. On edge, history rolls forward on requests at this cadence. |
| `retentionSeconds` | `number` | `60` | `60` | Chart history window. |
| `maxRecentErrors` | `number` | `10` | `10` | Errors kept in memory. |
| `maxRoutes` | `number` | `10` | `10` | Length of the top / slowest / error route lists. |
| `maxTrackedRoutes` | `number` | `1000` | `1000` | Hard cap on distinct routes in memory; least-recently-used are evicted. |
| `alerts` | `{ cpu, memory, responseTime, errorRate, eventLoopLag }` | `80, 90, 500, 5, 100` | same | Thresholds. Only `responseTime` and `errorRate` can fire on edge. |
| `onAlert` | `(event) => void` | – | – | Called on each OK ↔ breached transition. |
| `healthCheck` | `() => Promise<HealthCheckResult>` | – | – | Single check, reported as `database`. Its `details.poolSize` / `availableConnections` feed the snapshot's `database` field. |
| `healthChecks` | `Record<string, fn \| { check, required?, timeoutMs? }>` | – | – | Named checks, run in parallel. Takes precedence over `healthCheck` for `/health`. A check with `required: false` is shown but never makes `/health` 503. |
| `healthCheckTimeout` | `number` (ms) | `5000` | `5000` | Per-check timeout; a timed-out check reports down. `0` disables it. |
| `normalizePath` | `(path) => string` | see below | same | Groups paths into routes. |
| `groupBy` | `'path' \| 'route'` | `'path'` | `'path'` | `'route'` groups by the Hono route pattern that handled the request (`/users/:id`); unmatched requests fall back to `normalizePath`. |
| `ignorePaths` | `(string \| RegExp)[] \| (path) => boolean` | `[]` | `[]` | Requests left out entirely. Strings match exactly, or as a prefix when they end in `/*`. RegExps run against every request path, so avoid patterns with nested quantifiers. |
| `sampleRate` | `number` (0–1) | `1` | `1` | Fraction of requests recorded in per-route stats, percentiles and histograms. Total requests, status codes and the overall error rate always include every request. |
| `logger` | `{ warn, error, log?, info? } \| false` | `console` | `console` | Where the monitor's own messages go (console, pino, winston…); `false` silences them. |
| `maxStreamClients` | `number` | `100` | – | Concurrent `/api/stream` connections; extra clients get 503 and the dashboard polls instead. The cap is global, so set `authorize` if the dashboard is reachable from the internet. |
| `prometheus` | `boolean` | `true` | `true` | Expose `/prometheus`. |
| `prometheusPrefix` | `string` | `'hono'` | `'hono'` | Metric name prefix, also used for custom metrics. |
| `prometheusHistogram` | `boolean` | `false` | `false` | Add the per-route `http_request_duration_seconds` histogram. |
| `chartjsUrl` / `chartAdapterUrl` | `string` | jsDelivr, pinned + SRI | same | Self-host Chart.js (a relative URL is allowed by the CSP as `'self'`). |
| `inlineCharts` | `boolean` | `false` | `false` | Built-in renderer, no external scripts at all. |
| `securityHeaders` | `boolean` | `true` | `true` | Nonce CSP + same-origin framing on the dashboard (see [Security](#security)). Set `false` to embed the dashboard cross-origin. |
| `clusterMode` | `boolean` | auto-detected | – | Aggregate PM2 / `node:cluster` workers. |
| `store` | `StatusStore` | – | – | KV-shaped store for aggregating edge isolates (see below). No-op on Node. |
| `instanceId` | `string` | – | random | Stable id for this isolate in `store`. |
| `storeWriteInterval` | `number` (ms) | – | `60000` | How often an isolate writes to `store`. |
| `maxPeers` | `number` | – | `50` | Upper bound on peer snapshots read from `store` per refresh. |

**Validation.** An option that can't work throws a `StatusMonitorConfigError` when the monitor is created. Its `problems` array lists every problem at once: numeric ranges (zero or negative intervals and caps, `NaN`, `sampleRate` outside 0–1), wrong types for functions, booleans and strings, a `path` without a leading `/`, an unknown `groupBy`, a malformed `ignorePaths`, `healthChecks` entry, `store` or `logger`. `undefined` means "use the default", and numeric strings such as `'120'` are accepted.

```typescript
import { StatusMonitorConfigError } from 'hono-status-monitor';
try { statusMonitor(config); } catch (e) { if (e instanceof StatusMonitorConfigError) console.error(e.problems); throw e; }
```

**Default path normalization** collapses UUIDs to `:uuid`, 24-hex ObjectIds and all-digit segments to `:id`, then **keeps the first three path segments** — `/api/v1/users/42/posts` is tracked as `/api/v1/users`. Pass `normalizePath` to change that; you can build on the default:

```typescript
import { defaultNormalizePath } from 'hono-status-monitor';
statusMonitor({ authorize, normalizePath: (p) => p.startsWith('/api/v2/') ? p.replace(/\/\d+/g, '/:id') : defaultNormalizePath(p) });
```

### The returned handle

`statusMonitor()` returns a `StatusMonitor` handle: `{ middleware, routes, start(), stop(), getMetrics(), getCharts(), getHealth(), trackRateLimit(blocked), resetStats(), counter(name, help?), gauge(name, help?), monitor, isEdgeMode }`. `middleware` is a Hono `MiddlewareHandler`, `routes` a `Hono` app, and `monitor` the underlying collector (`Monitor` on Node/Bun/Deno, `EdgeMonitor` on edge).

Creating a monitor has no side effects. Collection starts on the first request through `middleware` or a status route, or when you call `start()`. `stop()` releases the collector and stays in effect until `start()` is called again. The Node collector's timer is `unref`'d, so it never keeps a process alive on its own.

### Exports

| Export | Entry | Purpose |
|---|---|---|
| `statusMonitor` (also default export, `statusMonitorEdge`) | main, `/edge` | The factory above. |
| `StatusMonitorConfigError` | main, `/edge` | Thrown for invalid config; has `problems: string[]`. |
| `createMonitor` / `createEdgeMonitor` | main / both | Lower-level collectors without routes. |
| `createMiddleware`, `createRequestTrackingMiddleware` | main, `/edge` | Tracking middleware for a collector. |
| `generateDashboard` / `generateEdgeDashboard` | main / both | Render the dashboard HTML yourself. |
| `toPrometheus`, `escapeHtml` | main, `/edge` | Formatters. |
| `defaultNormalizePath` | main, `/edge` | The default route normalizer. |
| `mergeSnapshots`, `generateInstanceId` | main, `/edge` | Edge cross-isolate helpers. |
| `detectPlatform`, `isNodeEnvironment`, `isBunEnvironment`, `isDenoEnvironment`, `isCloudflareEnvironment`, `isEdgeEnvironment`, `getPlatformInfo` | main, `/edge` | Runtime detection. |
| `setupClusterPrimary`, `isClusterWorker`, `isClusterMaster`, `getWorkerId`, `createClusterAggregator` | main | PM2 / cluster support. |
| `registerOtelMetrics` | `hono-status-monitor/otel` | [OpenTelemetry bridge](#opentelemetry). |
| `durableObjectStore`, `StatusStoreObject` | `hono-status-monitor/durable-object` | [Durable Object store](#durable-object-store). |
| Types: `StatusMonitor`, `StatusMonitorConfig`, `MetricsSnapshot`, `ChartData`, `HealthReport`, `HealthCheckResult`, `StatusStore`, `CounterMetric`, `GaugeMetric`, … | main, `/edge` | |

### Aggregating edge isolates

Each Workers isolate keeps its own counters. Pass a KV namespace (or anything implementing `get` / `put` / `list`) as `store` and the dashboard shows an approximate fleet-wide view:

```typescript
statusMonitor({ authorize, store: env.STATUS_KV, storeWriteInterval: 60_000 });
```

Each isolate writes its numbers from the request path (through `executionCtx.waitUntil`) once per `storeWriteInterval`, and peer snapshots are cached between writes, so a dashboard poll costs no KV reads most of the time. Counts are summed across isolates; response time and error rate are weighted by traffic. Charts stay per isolate. KV is eventually consistent, so expect the fleet view to lag by up to a minute. See the [cookbook](./docs/cookbook.md) for a complete Worker.

### Durable Object store

For a fleet view without KV's lag, back `store` with a single Durable Object:

```typescript
import { durableObjectStore } from 'hono-status-monitor/durable-object';
export { StatusStoreObject } from 'hono-status-monitor/durable-object';   // must be exported from the Worker's main module

statusMonitor({ authorize, store: durableObjectStore(env.STATUS_STORE), storeWriteInterval: 15_000 });
```

Reads see every earlier write, and `list()` is one in-memory scan. Setup (binding and migration) and trade-offs versus KV: [docs/durable-object-store.md](./docs/durable-object-store.md).

## Custom metrics

Register application counters and gauges on the handle. They're exported on `/prometheus` as `<prometheusPrefix>_<name>` and listed under `custom` in `/api/metrics`:

```typescript
const orders = monitor.counter('orders_total', 'Orders placed');
orders.inc({ plan: 'pro' });          // +1
orders.inc({ plan: 'free' }, 3);      // +3

const queue = monitor.gauge('queue_depth', 'Jobs waiting');
queue.set(42);
queue.inc({ queue: 'emails' }, -1);   // gauges can go down
```

```
# HELP hono_orders_total Orders placed
# TYPE hono_orders_total counter
hono_orders_total{plan="pro"} 1
```

- Calling `counter()` / `gauge()` again with the same name returns the same metric; reusing a name for the other type throws.
- Names and label keys must match `[a-zA-Z_][a-zA-Z0-9_]*`. Values must be finite, and a counter can't decrease.
- Each metric keeps at most 200 label combinations; further ones are dropped with a single warning. Don't use user IDs or raw paths as labels.
- Metrics are per instance: they are not merged across cluster workers or edge isolates.

## OpenTelemetry

`registerOtelMetrics()` publishes the monitor's metrics as OpenTelemetry observable instruments on any `@opentelemetry/api` `Meter`. The package has no OTel dependency.

```typescript
import { metrics } from '@opentelemetry/api';
import { registerOtelMetrics } from 'hono-status-monitor/otel';

const otel = registerOtelMetrics(metrics.getMeter('my-app'), monitor);   // { prefix, includeSystem, onError }
// otel.unregister() on shutdown
```

Pass `{ includeSystem: false }` on edge runtimes. SDK setup and the full metric mapping: [docs/opentelemetry.md](./docs/opentelemetry.md).

## Prometheus / Grafana

Scrape `/status/prometheus` — emits `<prefix>_cpu_percent`, `_heap_used_bytes`, `_rps`, `_response_time_p95_ms`, `_requests_total`, `_http_responses_total{code="..."}`, etc., plus, with `prometheusHistogram: true`, a latency histogram per route. On edge, the system gauges (`_cpu_percent`, `_memory_used_bytes`, `_memory_percent`, `_heap_used_bytes`, `_heap_total_bytes`, `_load_average`, `_event_loop_lag_ms`) aren't emitted.

```
hono_http_request_duration_seconds_bucket{method="GET",route="/users/:id",status="200",le="0.05"} 1832
```

Use it for quantiles across instances — the `_p95_ms` gauges are per process and can't be averaged:

```promql
histogram_quantile(0.95, sum by (le, route) (rate(hono_http_request_duration_seconds_bucket[5m])))
```

The histogram is opt-in (`prometheusHistogram: true`) because it adds up to 14 series per route and status. Pair it with `groupBy: 'route'` so the `route` label has bounded cardinality.

The scraper must get past `authorize` too (for example a bearer token, see the [cookbook](./docs/cookbook.md#prometheus)):

```yaml
scrape_configs:
  - job_name: my-app
    metrics_path: /status/prometheus
    authorization: { type: Bearer, credentials_file: /etc/prometheus/status-token }
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

The dashboard exposes hostname, PID, routes and errors, so the status surface is **closed by default**. Until you set `authorize` or `publicAccess: true`, the dashboard, `/api/metrics`, `/api/stream`, `/prometheus` and `/health` all answer 403 with a message explaining how to open them, and the monitor logs one warning when it's created.

```typescript
// Built-in guard — compare secrets in constant time (works on every runtime)
import { timingSafeEqual } from 'hono/utils/buffer';
const token = process.env.STATUS_TOKEN;
statusMonitor({
  // Reject outright when the secret is unset — timingSafeEqual('', '') is true.
  authorize: async (c) => !!token && timingSafeEqual(c.req.header('x-token') ?? '', token),
});

// …or your own auth middleware in front of the routes. The monitor can't see it,
// so tell it the routes may answer:
import { basicAuth } from 'hono/basic-auth';
const monitor = statusMonitor({ publicAccess: true });
app.use('/status/*', basicAuth({ username: 'admin', password: process.env.STATUS_PASSWORD! }));
app.route('/status', monitor.routes);
```

For local development, `publicAccess: process.env.NODE_ENV !== 'production'` keeps the dashboard open on your machine and closed in production.

**Health probes.** `/health` is behind the same gate. Point load-balancer and Kubernetes probes at a separate route built on `monitor.getHealth()`, or allow the probe path in `authorize`; see [Kubernetes probes](./docs/cookbook.md#kubernetes-probes-with-authorize-set).

**Headers.** Every status response sends `Cache-Control: no-store`, and the dashboard also sends `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. By default (`securityHeaders: true`) the dashboard also gets a per-response nonce-based `Content-Security-Policy` (scripts limited to its own inline script and the Chart.js origin) and same-origin framing (`frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`). Set `securityHeaders: false` to embed the dashboard in a cross-origin iframe (Grafana, Backstage…) or behind a proxy that injects scripts. If a custom `chartjsUrl` can't be expressed as a CSP source, the CSP is omitted rather than sent in a form that would block it. The default Chart.js scripts carry Subresource Integrity hashes, and if the CDN is unreachable the dashboard falls back to its built-in renderer.

Route paths are HTML-escaped before rendering, so hostile request paths can't inject scripts into the dashboard.

## Upgrading

From 1.x to 2.0, follow the [migration guide](./docs/migrating-to-2.md): it covers each breaking change with before/after code and how to keep the 1.x behaviour (`publicAccess: true`, `securityHeaders: false`, `healthCheckTimeout: 0`). Release notes are in [CHANGELOG.md](./CHANGELOG.md).

## Requirements

Node ≥ 20 · Bun ≥ 1.0 · Deno 2.x · Hono 4 (`^4.0.0`) · `@hono/node-server` ≥ 1.0 (Node only).

## License

MIT © [Vinit Kumar Goel](https://github.com/vinitkumargoel)

---

Pairing app telemetry with external risk awareness? ThreatFrontier tracks [emerging CVEs and exploitation trends](https://threatfrontier.com/) — a solid [cybersecurity news source](https://threatfrontier.com/) for security teams.
