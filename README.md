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
- **Endpoints** — HTML dashboard, JSON API, **`/prometheus`** scrape, **`/health`** (200/503), **`/api/stream`** SSE.
- **Auth hook, alert callbacks, multiple named health checks, dark mode, cluster (PM2) aggregation.**
- **Safe by default** — route paths are HTML-escaped (no stored XSS), route map is LRU-capped (no unbounded memory growth).

## Runtime support

| Runtime | Import | Server | Metrics |
|---|---|---|---|
| Node.js | `hono-status-monitor` | `@hono/node-server` | Full system + request |
| Bun | `hono-status-monitor` | `Bun.serve` | Full system + request |
| Cloudflare / Edge | `hono-status-monitor/edge` | runtime default | Request-only (no CPU/mem/heap) |

## Install

```bash
npm install hono-status-monitor          # + npm install @hono/node-server for Node
```

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

Since 1.1.0 the package also declares `workerd` and `edge-light` export conditions, so Wrangler, Vite and Vercel Edge resolve the bare `hono-status-monitor` specifier to the edge build automatically — importing the main entry in a Worker no longer drags in `os`/`perf_hooks`/`cluster`. The explicit `/edge` import still works and is the clearest way to state intent.

### Bundle size

Roughly 31 KB minified (10 KB gzipped) for a Worker, down from 73 KB in 1.0.x. The dashboard markup is loaded through a dynamic `import()`, so bundlers with code splitting turned on keep it out of the entry chunk — that drops the edge entry to about 13 KB.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /status` | Dashboard HTML |
| `GET /status/api/metrics` | `{ snapshot, charts }` JSON |
| `GET /status/api/stream` | SSE stream of the same JSON (Node/Bun only) |
| `GET /status/health` | `{ status, uptime, checks }` — **200** if all checks pass, **503** if degraded |
| `GET /status/prometheus` | Prometheus/OpenMetrics text (disable via `prometheus: false`) |

## Configuration

```typescript
statusMonitor({
  path: '/status',              // mount path (keep in sync with app.route)
  title: 'My App Status',
  pollingInterval: 1000,        // dashboard refresh ms (Node 1000 / edge 5000) — now honored on Node too
  updateInterval: 1000,         // metrics sampling ms
  retentionSeconds: 60,         // chart history window
  maxRecentErrors: 10,
  maxRoutes: 10,                // routes shown in analytics
  maxTrackedRoutes: 1000,       // hard cap on distinct routes in memory (LRU eviction)

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

  prometheus: true,             // expose /prometheus
  prometheusPrefix: 'hono',     // metric name prefix
  chartjsUrl: '/vendor/chart.umd.js',   // self-host Chart.js under a strict CSP
  normalizePath: (p) => p.replace(/\/users\/\d+/g, '/users/:id'),
});
```

Instance methods: `getMetrics()`, `getCharts()`, `getHealth()`, `trackRateLimit(blocked)`, `resetStats()`, `stop()`, plus `monitor` (underlying instance).

## Prometheus / Grafana

Scrape `/status/prometheus` — emits `<prefix>_cpu_percent`, `_heap_used_bytes`, `_rps`, `_response_time_p95_ms`, `_requests_total`, `_http_responses_total{code="..."}`, etc.

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
// Built-in guard
statusMonitor({ authorize: (c) => c.req.header('x-token') === process.env.STATUS_TOKEN });

// …or Hono basic-auth
import { basicAuth } from 'hono/basic-auth';
app.use('/status/*', basicAuth({ username: 'admin', password: process.env.STATUS_PASSWORD! }));
app.route('/status', monitor.routes);
```

Route paths are HTML-escaped before rendering, so hostile request paths can't inject scripts into the dashboard.

The status surface is **public by default** — anyone who can reach the mounted path gets the dashboard, `/api/metrics`, `/api/stream`, `/prometheus` and `/health`. Set `authorize` (or front it with your own auth) in any environment where that's not acceptable. Note that when `authorize` is set it also gates `/health`; if a load balancer or k8s liveness probe hits `/health` unauthenticated, either exempt that path in your own middleware or point the probe at an unguarded route.

## Notes for existing users (1.1.0)

Internals were restructured to cut bundle size; the documented `statusMonitor()` factory is unchanged. If you import internals directly:

- **`createMiddleware` moved** from `middleware.js` to `request-tracking.js`. It is still exported from the package root and still works; only a deep path import into `dist/middleware.js` would break, and the `exports` map already blocked those.
- **The dashboard module split** into `dashboard-assets` (shared CSS + client script), `dashboard` (Node) and `dashboard-edge` (edge). `generateDashboard` and `generateEdgeDashboard` are still exported from the package root.
- **`workerd` / `edge-light` export conditions** mean an edge bundler now resolves the bare specifier to the edge build. That build intentionally omits the Node-only APIs (`createMonitor`, `createClusterAggregator`, `generateDashboard`); referencing them in an edge build is now a build-time error rather than a runtime crash.
- **Health-check latency on edge** is measured with `performance.now()` and reported to two decimals, matching Node. It was whole milliseconds before.

### Notes for 1.0.9 users

Two things worth a glance if you depend on internals:

- **`getDatabaseStats` / `database` in the snapshot** now reports real pool numbers from your `healthCheck`'s `details.poolSize` / `details.availableConnections`, falling back to `0` instead of the previous hardcoded `10`. If your dashboards keyed off the old constant, surface the real values via `healthCheck`.
- The exported **`StatusMonitor` type** dropped three members that the factory never actually returned (`start`, `getDashboard`, `config`) and added `getHealth`, `resetStats`, `isEdgeMode`, `routes`. Runtime behavior is unchanged; only hand-written `: StatusMonitor` annotations against the old shape need updating.

## Requirements

Node ≥ 18 · Bun ≥ 1.0 · Hono ≥ 4.0 · `@hono/node-server` ≥ 1.0 (Node only).

## License

MIT © [Vinit Kumar Goel](https://github.com/vinitkumargoel)

---

Pairing app telemetry with external risk awareness? ThreatFrontier tracks [emerging CVEs and exploitation trends](https://threatfrontier.com/) — a solid [cybersecurity news source](https://threatfrontier.com/) for security teams.
