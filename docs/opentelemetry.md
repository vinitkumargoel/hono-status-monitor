# OpenTelemetry

`registerOtelMetrics()` publishes the monitor's metrics as OpenTelemetry observable instruments. The package does not depend on `@opentelemetry/*`: it accepts anything shaped like `@opentelemetry/api`'s `Meter`, so you bring your own API and SDK versions. The bridge has no `node:` imports and works on edge runtimes.

## Usage

```ts
import { Hono } from 'hono';
import { metrics } from '@opentelemetry/api';
import { statusMonitor } from 'hono-status-monitor';
import { registerOtelMetrics } from 'hono-status-monitor/otel';

const app = new Hono();
const monitor = statusMonitor({ authorize: (c) => isAdmin(c) });   // isAdmin: your own check
app.use('*', monitor.middleware);
app.route('/status', monitor.routes);

const otel = registerOtelMetrics(metrics.getMeter('my-app'), monitor);

// later, e.g. on shutdown or hot reload
otel.unregister();
```

`metrics.getMeter()` returns a no-op meter until a global `MeterProvider` is registered, so register the SDK first (next section).

### Options

| Option | Default | Meaning |
|---|---|---|
| `prefix` | `'hono'` | Instrument name prefix (`hono.http.requests`). Characters outside `[A-Za-z0-9_.-/]` become `_`. |
| `includeSystem` | `true` | Publish CPU, memory, heap, load average and event-loop lag. Set `false` on edge runtimes, where these values aren't available. |
| `onError` | none | Called with the error when a snapshot fails. That collection cycle is skipped; the callback never throws. |

## SDK setup (Node.js, OTLP)

```ts
import { metrics } from '@opentelemetry/api';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { statusMonitor } from 'hono-status-monitor';
import { registerOtelMetrics } from 'hono-status-monitor/otel';

const provider = new MeterProvider({
    resource: resourceFromAttributes({ 'service.name': 'my-app' }),
    readers: [
        new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: 'http://localhost:4318/v1/metrics' }),
            exportIntervalMillis: 15_000,
        }),
    ],
});
metrics.setGlobalMeterProvider(provider);

const monitor = statusMonitor({ authorize: (c) => isAdmin(c) });
monitor.start();   // optional: begin sampling now rather than at the first export
registerOtelMetrics(metrics.getMeter('my-app'), monitor);

process.on('SIGTERM', () => provider.shutdown());
```

Since 2.0 a monitor starts collecting on first use: a request through `monitor.middleware`, an authorized status-route hit, or a `getMetrics()` call (which is what the bridge does). Call `monitor.start()` up front if you want CPU and event-loop history to cover the time before the first export.

If you already use `@opentelemetry/sdk-node`, skip the provider setup: `NodeSDK` registers the global provider, and `metrics.getMeter('my-app')` picks it up.

On Cloudflare Workers and other edge runtimes, create the monitor from `hono-status-monitor/edge` (or the main entry, which resolves to the edge build there) and pass `{ includeSystem: false }`. `hono-status-monitor/otel` has no `node:` imports.

## How collection works

All instruments share one batch callback (`meter.addBatchObservableCallback`). Each time the SDK collects, the bridge calls `getMetrics()` once and reports every instrument from that snapshot. Non-finite values (`NaN`, `Infinity`) are not reported.

## Metric mapping

Names below use the default `hono` prefix. The Prometheus column is the matching series from the monitor's own `/status/prometheus` endpoint. An OTel-to-Prometheus exporter produces different names from the OTel ones (dots become underscores, units and `_total` are appended).

| OTel instrument | Type | Unit | Attributes | Meaning | Prometheus equivalent |
|---|---|---|---|---|---|
| `hono.http.request.rate` | gauge | `{request}/s` | | Requests per second | `hono_rps` |
| `hono.http.response_time` | gauge | `ms` | | Average response time | `hono_response_time_ms` |
| `hono.http.response_time.quantile` | gauge | `ms` | `quantile` = `0.5` / `0.95` / `0.99` | Response time percentiles | `hono_response_time_p50_ms`, `_p95_ms`, `_p99_ms` |
| `hono.http.error_rate` | gauge | `%` | | Error rate percentage | `hono_error_rate_percent` |
| `hono.http.active_requests` | gauge | `{request}` | | In-flight requests | `hono_active_connections` |
| `hono.http.requests` | counter | `{request}` | | Total requests observed | `hono_requests_total` |
| `hono.http.responses` | counter | `{response}` | `status` (e.g. `200`) | Responses by status code | `hono_http_responses_total{code}` |
| `hono.cpu.usage` | gauge | `%` | | CPU usage | `hono_cpu_percent` |
| `hono.memory.used` | gauge | `By` | | System memory used | `hono_memory_used_bytes` |
| `hono.memory.usage` | gauge | `%` | | System memory used percentage | `hono_memory_percent` |
| `hono.heap.used` | gauge | `By` | | Heap used | `hono_heap_used_bytes` |
| `hono.heap.total` | gauge | `By` | | Heap total | `hono_heap_total_bytes` |
| `hono.event_loop.lag` | gauge | `ms` | | Event loop lag | `hono_event_loop_lag_ms` |
| `hono.system.load_average.1m` | gauge | `1` | | 1-minute load average | `hono_load_average` |

The last seven are omitted with `includeSystem: false`.

The percentile gauges are per instance and can't be averaged across instances. For fleet-wide latency quantiles, use the Prometheus histogram `hono_http_request_duration_seconds`, or your own OTel histogram recorded in middleware.
