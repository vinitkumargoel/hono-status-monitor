# Cookbook

Copy-pasteable setups for each runtime and for common deployment needs. All examples use version 1.2. The package is ESM-only.

Two entries:

| Entry | Use on | Metrics |
|---|---|---|
| `hono-status-monitor` | Node.js, Bun | System (CPU, memory, heap, load, event-loop lag, GC) + request metrics, SSE `/api/stream`, cluster helpers |
| `hono-status-monitor/edge` | Cloudflare Workers, Deno, Vercel Edge | Request metrics only; no `node:` imports; no SSE stream |

Every recipe mounts the same way:

```ts
app.use('*', monitor.middleware);       // register before your routes
app.route('/status', monitor.routes);   // must match config.path (default '/status')
```

If you mount somewhere else, set `path` to the full request path of the mount (for example `path: '/admin/status'`). The middleware uses it to leave the dashboard's own requests out of the metrics.

Contents:

- [Node.js](#nodejs)
- [Bun](#bun)
- [Cloudflare Workers](#cloudflare-workers)
- [Deno](#deno)
- [Vercel Edge / Next.js App Router](#vercel-edge--nextjs-app-router)
- [Node cluster / PM2](#node-cluster--pm2)
- [Putting the dashboard behind auth](#putting-the-dashboard-behind-auth)
- [Kubernetes probes with `authorize` set](#kubernetes-probes-with-authorize-set)
- [Prometheus](#prometheus)
- [Grafana embedding](#grafana-embedding)

---

## Node.js

```bash
npm install hono @hono/node-server hono-status-monitor
```

```ts
// server.ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { statusMonitor } from 'hono-status-monitor';

const app = new Hono();

const monitor = statusMonitor({
  title: 'My App',
  groupBy: 'route',                           // group by Hono route pattern: /users/:id
  ignorePaths: ['/favicon.ico', '/assets/*'], // not counted at all
});

app.use('*', monitor.middleware);
app.route('/status', monitor.routes);

app.get('/', (c) => c.text('Hello'));
app.get('/users/:id', (c) => c.json({ id: c.req.param('id') }));

const server = serve({ fetch: app.fetch, port: 3000 });

// Optional: release the collector on shutdown.
process.on('SIGTERM', () => {
  monitor.stop();
  server.close();
  // Open dashboards hold an SSE connection; end it so close() can finish.
  if ('closeAllConnections' in server) server.closeAllConnections();
});
```

Dashboard: `http://localhost:3000/status`. On Node and Bun the dashboard receives updates over SSE (`/status/api/stream`) and falls back to polling `/status/api/metrics` if the stream can't be opened.

## Bun

```bash
bun add hono hono-status-monitor
```

```ts
// server.ts
import { Hono } from 'hono';
import { statusMonitor } from 'hono-status-monitor';

const app = new Hono();
const monitor = statusMonitor({ groupBy: 'route' });

app.use('*', monitor.middleware);
app.route('/status', monitor.routes);
app.get('/', (c) => c.text('Hello from Bun'));

Bun.serve({ fetch: app.fetch, port: 3000 });
```

Bun uses the main entry and gets the full system metrics.

## Cloudflare Workers

Use the `/edge` entry. It has no `node:` imports, so `nodejs_compat` is not needed.

Each isolate keeps its own counters. To see approximate fleet-wide numbers, pass a KV namespace as `store`: every isolate writes its snapshot at most once per `storeWriteInterval` (default 60000 ms, via `executionCtx.waitUntil` so the response isn't delayed), and the dashboard merges the snapshots it reads back. Peer snapshots are cached between reads, and at most `maxPeers` (default 50) are read per refresh.

```bash
npx wrangler kv namespace create STATUS_KV
npx wrangler secret put STATUS_TOKEN
```

```toml
# wrangler.toml
name = "my-worker"
main = "src/index.ts"
compatibility_date = "2025-01-01"

[[kv_namespaces]]
binding = "STATUS_KV"
id = "<your-kv-namespace-id>"
```

```ts
// src/index.ts
import { Hono, type ExecutionContext } from 'hono';
import { timingSafeEqual } from 'hono/utils/buffer';
import { statusMonitor, type StatusStore } from 'hono-status-monitor/edge';

interface Env {
  STATUS_KV: StatusStore;   // a KV namespace satisfies this interface
  STATUS_TOKEN?: string;
}

type App = Hono<{ Bindings: Env }>;

function createApp(env: Env): App {
  const monitor = statusMonitor({
    store: env.STATUS_KV,
    storeWriteInterval: 60_000,
    groupBy: 'route',
    authorize: async (c) => {
      if (!env.STATUS_TOKEN) return false;
      return timingSafeEqual(c.req.header('x-token') ?? '', env.STATUS_TOKEN);
    },
  });

  const app: App = new Hono<{ Bindings: Env }>();
  app.use('*', monitor.middleware);
  app.route('/status', monitor.routes);
  app.get('/users/:id', (c) => c.json({ id: c.req.param('id') }));
  return app;
}

// Bindings only exist inside fetch, so build once per isolate on the first
// request and reuse it. A monitor created per request starts from zero each time.
let app: App | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    app ??= createApp(env);
    return app.fetch(request, env, ctx);
  },
};
```

A full project is in [`examples/cloudflare-workers`](../examples/cloudflare-workers).

What to expect with a store:

- Numeric cards (requests, RPS, response time, error rate, status codes, route lists, recent errors) are merged across isolates. Treat them as approximate.
- Charts stay per-isolate: time series from different isolates can't be summed.
- KV is eventually consistent, and each isolate writes at most once per `storeWriteInterval`. Expect fleet numbers to lag by about a minute. KV's minimum TTL is 60 s, so entries live at least that long; a stopped isolate's entry expires on its own.
- Cost: one KV write per active isolate per `storeWriteInterval`, plus one `list` and up to `maxPeers` reads per dashboard refresh when the peer cache is cold. Raise `storeWriteInterval` or `pollingInterval` if that's too much.

`store` accepts anything with `get` / `put` / `list` (see the exported `StatusStore` type), so a Durable Object stub or custom store also works.

## Deno

```ts
// main.ts — deno run --allow-net --allow-env main.ts
import { Hono } from 'npm:hono';
import { statusMonitor } from 'npm:hono-status-monitor/edge';

const app = new Hono();
const monitor = statusMonitor({ groupBy: 'route' });

app.use('*', monitor.middleware);
app.route('/status', monitor.routes);
app.get('/', (c) => c.text('Hello from Deno'));

Deno.serve({ port: 8000 }, app.fetch);
```

The dashboard labels the runtime as Deno. Metrics are request-only, as on Workers.

## Vercel Edge / Next.js App Router

Save as `app/api/[[...route]]/route.ts`:

```ts
import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { statusMonitor } from 'hono-status-monitor/edge';

export const runtime = 'edge';

const app = new Hono().basePath('/api');

// path is the full request path, basePath included.
const monitor = statusMonitor({ path: '/api/status', groupBy: 'route' });

app.use('*', monitor.middleware);
app.route('/status', monitor.routes);
app.get('/hello', (c) => c.json({ ok: true }));

export const GET = handle(app);
export const POST = handle(app);
```

Dashboard: `/api/status`. Each edge instance has its own counters; there is no KV binding here, so numbers are per instance. If you need aggregation, pass an object implementing `StatusStore` (`get` / `put` / `list`) over a key-value service you already use as `store`.

## Node cluster / PM2

Metrics aggregate across workers over IPC; no Redis needed. Fork workers from a primary that calls `setupClusterPrimary()`:

```ts
// cluster.ts
import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { setupClusterPrimary } from 'hono-status-monitor';

if (cluster.isPrimary) {
  for (let i = 0; i < availableParallelism(); i++) cluster.fork();
  setupClusterPrimary();              // relay worker metrics; respawn dead workers
  // setupClusterPrimary({ respawn: false }) to manage respawning yourself
} else {
  await import('./server.js');        // the Node.js server above
}
```

Workers detect cluster mode automatically (`cluster.isWorker` or PM2's `NODE_APP_INSTANCE`). Set `clusterMode` explicitly to override detection.

With PM2, run the cluster entry as a single instance:

```bash
pm2 start cluster.js --name my-app
```

Don't start the app with `pm2 start server.js -i max`: PM2 cluster instances aren't forked by your primary, so there is no primary to relay metrics between them.

`availableParallelism()` needs Node 18.14+; use `os.cpus().length` on older versions.

## Putting the dashboard behind auth

The status surface is public unless you protect it. In production (`NODE_ENV=production`) the monitor logs a warning when `authorize` isn't set.

### `authorize`

`authorize(c)` runs before every status route (dashboard, `/api/metrics`, `/api/stream`, `/prometheus`, `/health`). Return `false`, or throw, to get a 401.

```ts
import { timingSafeEqual } from 'hono/utils/buffer';

const token = process.env.STATUS_TOKEN;

const monitor = statusMonitor({
  authorize: async (c) => {
    if (!token) return false;   // an unset secret must not match an empty header
    const header = c.req.header('authorization') ?? '';
    return timingSafeEqual(header, `Bearer ${token}`);
  },
});
```

`timingSafeEqual` from `hono/utils/buffer` is async and works on every runtime. A browser can't add a custom header to a page load, so header tokens suit API clients and scrapers. For people opening the dashboard in a browser, use cookie-based auth or basic auth.

### Hono `basicAuth`

```ts
import { basicAuth } from 'hono/basic-auth';

app.use('*', monitor.middleware);
app.use('/status/*', basicAuth({ username: 'admin', password: process.env.STATUS_PASSWORD! }));
app.route('/status', monitor.routes);   // after the auth middleware
```

`/status/*` also matches `/status` itself. The dashboard fetches its data with `credentials: 'same-origin'`, so the browser resends the basic-auth credentials on every poll and on the SSE stream.

Any other Hono auth middleware (JWT, session cookie, your identity-aware proxy) works the same way: register it on `/status/*` before `app.route`.

## Kubernetes probes with `authorize` set

`authorize` also gates `/status/health`, so an unauthenticated probe gets 401. Options:

**1. Expose health on a separate, unguarded route** (recommended; no metrics or dashboard exposed):

```ts
app.get('/healthz', async (c) => {
  const report = await monitor.getHealth();   // same payload as /status/health
  return c.json(report, report.status === 'ok' ? 200 : 503, { 'Cache-Control': 'no-store' });
});
```

If you don't want check details public, return only the status:

```ts
app.get('/healthz', async (c) => {
  const { status } = await monitor.getHealth();
  return c.text(status, status === 'ok' ? 200 : 503);
});
```

Add `ignorePaths: ['/healthz']` so probe traffic doesn't dominate the route stats.

**2. Exempt the path inside `authorize`:**

```ts
authorize: async (c) =>
  c.req.path === '/status/health' || (await isAdmin(c)),   // isAdmin: your own check
```

```yaml
# deployment.yaml (container spec)
livenessProbe:
  httpGet: { path: /healthz, port: 3000 }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /healthz, port: 3000 }
  periodSeconds: 5
```

Health checks that call a dependency should have a timeout so a hung dependency fails the probe instead of hanging it:

```ts
statusMonitor({
  healthCheckTimeout: 3000,        // default for every check (off by default in 1.x)
  healthChecks: {
    db: { check: pingDb, timeoutMs: 1000 },          // per-check override
    cache: { check: pingRedis, required: false },     // reported, never causes 503
  },
});
```

Consider liveness probes that don't depend on external services: a restart doesn't fix a database outage. `/health` results are cached for up to 1 s and shared between concurrent callers.

## Prometheus

`/status/prometheus` is on by default (`prometheus: false` disables it; `prometheusPrefix` changes the `hono` prefix). If `authorize` is set, the scraper has to authenticate too. With the bearer-token `authorize` above:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: my-app
    metrics_path: /status/prometheus
    scrape_interval: 15s
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/status-token
    static_configs:
      - targets: ['app.internal:3000']
```

Exposed series include gauges (`hono_cpu_percent`, `hono_heap_used_bytes`, `hono_rps`, `hono_response_time_p95_ms`, `hono_error_rate_percent`, ...), counters (`hono_requests_total`, `hono_http_responses_total{code}`, `hono_rate_limit_blocked_total`), and a latency histogram:

```
hono_http_request_duration_seconds_bucket{method,route,status,le}
hono_http_request_duration_seconds_sum{method,route,status}
hono_http_request_duration_seconds_count{method,route,status}
```

Buckets (seconds): 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10. The `route` label is the grouped route: the Hono pattern with `groupBy: 'route'`, otherwise the output of `normalizePath`.

Example queries:

```promql
# p95 latency per route over 5 minutes
histogram_quantile(0.95, sum by (le, route) (rate(hono_http_request_duration_seconds_bucket[5m])))

# p99 across the whole service
histogram_quantile(0.99, sum by (le) (rate(hono_http_request_duration_seconds_bucket[5m])))

# Request rate per route
sum by (route) (rate(hono_http_request_duration_seconds_count[5m]))

# 5xx ratio
sum(rate(hono_http_responses_total{code=~"5.."}[5m])) / sum(rate(hono_http_responses_total[5m]))

# Apdex-style: share of requests under 250 ms
sum(rate(hono_http_request_duration_seconds_bucket{le="0.25"}[5m])) / sum(rate(hono_http_request_duration_seconds_count[5m]))
```

Notes:

- Prefer the histogram over the `_p50_ms` / `_p95_ms` / `_p99_ms` gauges when aggregating across instances; percentile gauges can't be averaged.
- With `sampleRate` below 1, the histogram only holds sampled requests. `hono_requests_total` and `hono_http_responses_total` always count every request.
- Routes evicted by `maxTrackedRoutes` drop their histogram series, and `resetStats()` clears them; `rate()` handles the resulting counter resets.
- In cluster mode each worker exports its own histogram, and a scrape of the shared port reaches whichever worker accepts the connection.
- On edge, the histogram is per isolate.

## Grafana embedding

To show the dashboard inside Grafana (a Text panel in HTML mode with an `<iframe>`), Backstage or another tool on a different origin:

- Leave `securityHeaders` off (the 1.x default). With `securityHeaders: true` the dashboard sends `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so browsers refuse to render it in a cross-origin frame. Alternatively, serve Grafana and the app from the same origin behind a reverse proxy and keep `securityHeaders` on.
- The iframe can't send custom headers. If the dashboard is protected, use auth the browser sends by itself (a cookie for the app's domain, basic auth, or an authenticating proxy). Third-party cookies in cross-origin iframes are blocked by many browsers; same-origin avoids that.
- Grafana sanitizes HTML in Text panels by default; embedding an iframe requires `disable_sanitize_html = true` under `[panels]` in `grafana.ini`.

```html
<iframe src="https://app.example.com/status" width="100%" height="900" style="border:0"></iframe>
```

For native Grafana panels, scrape `/status/prometheus` instead (see [Prometheus](#prometheus)).
