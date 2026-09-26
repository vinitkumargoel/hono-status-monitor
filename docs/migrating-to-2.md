# Migrating from 1.x to 2.0

2.0 makes the status routes closed and hardened by default, fails fast on bad config, and removes the Socket.IO leftovers. Most apps need one line: an `authorize` (or `publicAccess: true`) option. Work through the sections below in order, then go through the [checklist](#checklist).

- [1. Requirements: Node 20+, Hono 4](#1-requirements-node-20-hono-4)
- [2. The status routes are closed by default](#2-the-status-routes-are-closed-by-default)
- [3. Load-balancer and Kubernetes probes](#3-load-balancer-and-kubernetes-probes)
- [4. `securityHeaders` defaults to true](#4-securityheaders-defaults-to-true)
- [5. `healthCheckTimeout` defaults to 5000 ms](#5-healthchecktimeout-defaults-to-5000-ms)
- [6. Invalid config throws `StatusMonitorConfigError`](#6-invalid-config-throws-statusmonitorconfigerror)
- [7. Collection starts lazily](#7-collection-starts-lazily)
- [8. Removed: `initSocket()`, `io`, `socketPath`, `hasWebSocketSupport`](#8-removed-initsocket-io-socketpath-haswebsocketsupport)
- [9. Platform detection and entry resolution](#9-platform-detection-and-entry-resolution)
- [10. Types](#10-types)
- [11. Prometheus on edge drops the system gauges](#11-prometheus-on-edge-drops-the-system-gauges)
- [12. Edge monitor start/stop no longer log](#12-edge-monitor-startstop-no-longer-log)
- [New in 2.0](#new-in-20-no-migration-needed)
- [Checklist](#checklist)

## 1. Requirements: Node 20+, Hono 4

Node 18 is no longer supported (`engines.node` is `>=20.0.0`). The `hono` peer dependency is now `^4.0.0` (it was `>=4.0.0`). Bun ≥ 1.0 is unchanged.

```bash
npm install hono-status-monitor@2
```

## 2. The status routes are closed by default

In 1.x every status route was public unless you set `authorize`. In 2.0 the dashboard, `/api/metrics`, `/api/stream`, `/health` and `/prometheus` answer **403** with a plain-text explanation until you set `authorize` or `publicAccess: true`. The monitor also logs one warning at construction when neither is set.

**Before (1.x)**

```ts
const monitor = statusMonitor();
```

**After (2.0), protected (recommended)**

```ts
import { timingSafeEqual } from 'hono/utils/buffer';

const token = process.env.STATUS_TOKEN;
const monitor = statusMonitor({
  // Falsy return or a thrown error → 401. Reject when the secret is unset.
  authorize: async (c) => !!token && timingSafeEqual(c.req.header('x-token') ?? '', token),
});
```

**After (2.0), public in development only**

```ts
const monitor = statusMonitor({ publicAccess: process.env.NODE_ENV !== 'production' });
```

**Keep the 1.x behaviour** (every route public):

```ts
const monitor = statusMonitor({ publicAccess: true });
```

**If you protect the path with your own middleware** (`basicAuth`, JWT, a session check or an authenticating proxy) instead of `authorize`, the monitor can't see it. Set `publicAccess: true` so the routes answer once your middleware lets the request through:

```ts
import { basicAuth } from 'hono/basic-auth';

const monitor = statusMonitor({ publicAccess: true });   // access is enforced by basicAuth below
app.use('*', monitor.middleware);
app.use('/status/*', basicAuth({ username: 'admin', password: process.env.STATUS_PASSWORD! }));
app.route('/status', monitor.routes);
```

The 1.2 warning that fired only when `NODE_ENV=production` and `authorize` was unset is gone; it's replaced by the 403 and the construction-time warning above.

## 3. Load-balancer and Kubernetes probes

`/status/health` is behind the same gate, so an unauthenticated probe now gets 403 (neither option set) or 401 (`authorize` rejects it). Pick one:

**A. A separate probe route** (recommended: exposes nothing else):

```ts
app.get('/healthz', async (c) => {
  const { status } = await monitor.getHealth();
  return c.text(status, status === 'ok' ? 200 : 503, { 'Cache-Control': 'no-store' });
});
```

Add `ignorePaths: ['/healthz']` so probe traffic stays out of the route stats.

**B. Let the probe through in `authorize`:**

```ts
statusMonitor({
  authorize: async (c) => c.req.path === '/status/health' || (await isAdmin(c)),   // isAdmin: your own check
});
```

**C. `publicAccess: true`**, if the whole surface may be public (as in 1.x).

## 4. `securityHeaders` defaults to true

The dashboard now sends a nonce-based `Content-Security-Policy` (scripts limited to its own inline script and the Chart.js origin) plus `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`. In 1.x this was opt-in.

You'll notice it if you embed the dashboard in a cross-origin iframe (Grafana, Backstage, a portal), or if a proxy/CDN injects scripts into the page (Cloudflare Rocket Loader, Zaraz, a corporate proxy). To keep the 1.x behaviour:

```ts
statusMonitor({ authorize, securityHeaders: false });
```

If the CSP blocks a self-hosted Chart.js, set `chartjsUrl` / `chartAdapterUrl` to its URL, or use `inlineCharts: true` (no external scripts).

## 5. `healthCheckTimeout` defaults to 5000 ms

A health check that hasn't settled after 5 s is reported as down (and `/health` returns 503 if the check is required). In 1.x there was no timeout. Checks that legitimately take longer need a per-check `timeoutMs` or a higher global value. To keep the 1.x behaviour:

```ts
statusMonitor({ authorize, healthCheckTimeout: 0 });   // 0 disables the timeout
```

Per-check override:

```ts
healthChecks: { warehouse: { check: pingWarehouse, timeoutMs: 15_000 } }
```

## 6. Invalid config throws `StatusMonitorConfigError`

1.x replaced an invalid numeric option with its default and logged a warning. 2.0 throws a `StatusMonitorConfigError` from `statusMonitor()` (and `createMonitor` / `createEdgeMonitor`). Its `message` and its `problems: string[]` list every problem at once. There is no way to restore the old fallback; fix the config.

Checked:

- numeric ranges (intervals, `retentionSeconds`, caps and `maxStreamClients` must be > 0; `maxRoutes`, `maxRecentErrors`, `healthCheckTimeout`, `maxPeers` ≥ 0; `sampleRate` 0–1; `alerts.*` finite numbers);
- functions (`healthCheck`, `normalizePath`, `authorize`, `onAlert`), booleans (`clusterMode`, `publicAccess`, `prometheus`, `prometheusHistogram`, `inlineCharts`, `securityHeaders`) and strings (`path`, `title`, `prometheusPrefix`, `chartjsUrl`, `chartAdapterUrl`, `instanceId`);
- `path` must start with `/`;
- `groupBy` is `'path'` or `'route'`;
- `ignorePaths` is an array of strings/RegExps or a function;
- each `healthChecks` entry is a function or `{ check }`;
- `store` implements `get`, `put` and `list`;
- `logger` is `false` or implements `log`, `warn` and `error`.

Numeric strings (from env vars) are still accepted, and `undefined` still means "use the default".

```ts
import { statusMonitor, StatusMonitorConfigError } from 'hono-status-monitor';

try {
  statusMonitor({ publicAccess: true, pollingInterval: Number(process.env.POLL_MS) });
} catch (err) {
  if (err instanceof StatusMonitorConfigError) console.error(err.problems);
  throw err;
}
```

Watch for `Number(undefined)` (`NaN`, which 1.x quietly replaced with the default) and `path: 'status'` (missing the leading slash, which 1.x didn't check): both throw now.

## 7. Collection starts lazily

In 1.x `statusMonitor()` started the collector immediately. In 2.0 creating a monitor has no side effects; collection starts on the first request through `monitor.middleware`, the first authorized status-route hit, the first `getMetrics()` / `getCharts()` / `getHealth()` call, or when you call `monitor.start()`. `stop()` now sticks: later requests don't restart the collector until you call `start()` again.

You only need to change something if you read metrics without routing requests through the monitor, for example `getMetrics()` from a job, a test, or an [OpenTelemetry bridge](./opentelemetry.md) in a process that doesn't mount the middleware:

```ts
const monitor = statusMonitor({ publicAccess: true });
monitor.start();   // begin sampling CPU, memory and event-loop lag now
```

## 8. Removed: `initSocket()`, `io`, `socketPath`, `hasWebSocketSupport`

These were no-op compatibility shims since the move off Socket.IO. Delete them:

| Removed | Replacement |
|---|---|
| `monitor.initSocket(server)` (handle and `monitor.monitor`) | Nothing. Cluster peers are listened to from `start()` since 1.2.0. |
| `monitor.monitor.io` | Nothing; live updates use SSE (`/api/stream`). |
| `socketPath` option, `DashboardProps.socketPath` | Nothing. |
| `getPlatformInfo().hasWebSocketSupport` | Nothing. |

**Before**

```ts
const server = serve({ fetch: app.fetch, port: 3000 });
monitor.initSocket(server);
```

**After**

```ts
serve({ fetch: app.fetch, port: 3000 });
```

## 9. Platform detection and entry resolution

- `detectPlatform()` can return `'deno'`. The check order is bun → deno → cloudflare → `EdgeRuntime` → node, so a Worker with `nodejs_compat` (which exposes `process.versions.node`) is now `'cloudflare'`, not `'node'`.
- New `isDenoEnvironment()`. `isEdgeEnvironment()` is `false` on Deno.
- **Deno gets the full monitor.** `statusMonitor()` from the main entry uses the Node-compatible collector on Deno (CPU, memory, heap, event loop, SSE). Switch Deno apps from `npm:hono-status-monitor/edge` to `npm:hono-status-monitor` to get it; the `/edge` entry still works and stays request-only.
- **The main entry resolves to the edge build under Wrangler and Vercel Edge.** The package's `"."` export has `workerd` and `edge-light` conditions, so `import 'hono-status-monitor'` in those bundles gets the Node-free edge build. In 1.x a Worker using `nodejs_compat` got the Node build; it now gets request-only metrics. `/edge` remains the explicit way to ask for it.

If you branch on `detectPlatform() === 'node'` to mean "Node-like", include `'bun'` and `'deno'` or use `getPlatformInfo().hasOsModule`.

## 10. Types

- `authorize` is typed `(c: Context) => boolean | Promise<boolean>` with Hono's `Context`; `c.req`, `c.env` and friends are typed.
- The handle is `StatusMonitor<M>` with `middleware: MiddlewareHandler` and `routes: Hono` (they were loosely typed). `statusMonitor()` from the main entry returns `StatusMonitor<Monitor | EdgeMonitor>`; from `/edge` it returns `StatusMonitor<EdgeMonitor>`. Narrow `monitor.monitor` with `isEdgeMode` if you use Node-only members.
- The handle gained `start()`, `counter()` and `gauge()` (see [custom metrics](../README.md#custom-metrics)); `initSocket` is gone.

## 11. Prometheus on edge drops the system gauges

Edge runtimes can't measure them, so `/prometheus` on edge no longer emits the always-zero `<prefix>_cpu_percent`, `_memory_used_bytes`, `_memory_percent`, `_heap_used_bytes`, `_heap_total_bytes`, `_load_average` and `_event_loop_lag_ms`. Remove them from edge dashboards and alerts; Node, Bun and Deno still export them.

## 12. Edge monitor start/stop no longer log

The edge collector's `start()` / `stop()` are silent. If you grepped logs for its start message, stop doing that.

## New in 2.0 (no migration needed)

- Custom counters and gauges on the handle: `monitor.counter(name, help?)`, `monitor.gauge(name, help?)`. See [custom metrics](../README.md#custom-metrics).
- OpenTelemetry bridge: `registerOtelMetrics` from `hono-status-monitor/otel`. See [OpenTelemetry](./opentelemetry.md).
- Durable Object store for edge fleet aggregation: `durableObjectStore` and `StatusStoreObject` from `hono-status-monitor/durable-object`. See [Durable Object store](./durable-object-store.md).

## Checklist

- [ ] Running on Node 20+ (or Bun/Deno), with `hono@^4`.
- [ ] Every `statusMonitor()` call sets `authorize` or `publicAccess`.
- [ ] Apps protected by their own middleware (basic auth, JWT, proxy) set `publicAccess: true`.
- [ ] Load-balancer / k8s probes hit a separate route, are allowed by `authorize`, or `publicAccess` is on.
- [ ] Cross-origin embeds (Grafana, Backstage) or script-injecting proxies: `securityHeaders: false`.
- [ ] Slow health checks have a `timeoutMs`, or `healthCheckTimeout: 0`.
- [ ] Config values from env vars can't be `NaN`; `path` starts with `/`. Startup doesn't throw `StatusMonitorConfigError`.
- [ ] If you need system history (CPU, event loop) from process start, call `start()` right after creating the monitor.
- [ ] `initSocket()`, `io`, `socketPath` and `hasWebSocketSupport` are removed.
- [ ] Deno apps import the main entry for full metrics (optional).
- [ ] Edge Prometheus queries don't use the removed system gauges.
- [ ] Code comparing `detectPlatform()` handles `'deno'`.
