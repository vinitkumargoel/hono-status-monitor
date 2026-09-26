// =============================================================================
// HONO STATUS MONITOR - SHARED FORMATTERS
// HTML escaping and Prometheus/OpenMetrics exposition
// =============================================================================

import type { MetricsSnapshot } from './types.js';
import { HISTOGRAM_BUCKETS_SECONDS, type RouteHistogram } from './stats-core.js';

/**
 * Escape a string for safe interpolation into HTML text/attribute contexts.
 * Used for server-rendered values (title, hostname) that can contain user data.
 */
export function escapeHtml(value: unknown): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function sanitizeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ');
}

function line(name: string, value: number, labels?: Record<string, string>): string {
    if (!Number.isFinite(value)) return '';
    const labelStr = labels
        ? '{' + Object.entries(labels)
            .map(([k, v]) => `${k}="${sanitizeLabel(v)}"`)
            .join(',') + '}'
        : '';
    return `${name}${labelStr} ${value}\n`;
}

/**
 * Render a metrics snapshot as Prometheus text exposition format (v0.0.4).
 * Scrapeable by Prometheus, Grafana Agent, VictoriaMetrics, etc.
 */
export function toPrometheus(
    snapshot: MetricsSnapshot,
    prefix = 'hono',
    histograms: RouteHistogram[] = [],
    options: { system?: boolean } = {}
): string {
    const p = prefix.replace(/[^a-zA-Z0-9_]/g, '_');
    let out = '';

    const gauge = (name: string, help: string, value: number, labels?: Record<string, string>) => {
        out += `# HELP ${p}_${name} ${help}\n# TYPE ${p}_${name} gauge\n`;
        out += line(`${p}_${name}`, value, labels);
    };
    const counter = (name: string, help: string, value: number, labels?: Record<string, string>) => {
        out += `# HELP ${p}_${name} ${help}\n# TYPE ${p}_${name} counter\n`;
        out += line(`${p}_${name}`, value, labels);
    };

    // System gauges are omitted where the runtime can't measure them (edge),
    // rather than exported as constant zeros that look like real readings.
    if (options.system !== false) {
        gauge('cpu_percent', 'CPU usage percentage', snapshot.cpu);
        gauge('memory_used_bytes', 'System memory used in bytes', snapshot.memoryMB * 1024 * 1024);
        gauge('memory_percent', 'System memory used percentage', snapshot.memoryPercent);
        gauge('heap_used_bytes', 'Heap used in bytes', snapshot.heapUsedMB * 1024 * 1024);
        gauge('heap_total_bytes', 'Heap total in bytes', snapshot.heapTotalMB * 1024 * 1024);
        gauge('load_average', 'System 1-minute load average', snapshot.loadAvg);
    }
    gauge('uptime_seconds', 'System uptime in seconds', snapshot.uptime);
    gauge('process_uptime_seconds', 'Process uptime in seconds', snapshot.processUptime);
    if (options.system !== false) {
        gauge('event_loop_lag_ms', 'Event loop lag in milliseconds', snapshot.eventLoopLag);
    }
    gauge('active_connections', 'In-flight requests', snapshot.activeConnections);
    gauge('rps', 'Requests per second', snapshot.rps);
    gauge('response_time_ms', 'Average response time (ms)', snapshot.responseTime);
    gauge('error_rate_percent', 'Error rate percentage', snapshot.errorRate);

    gauge('response_time_p50_ms', 'Response time p50 (ms)', snapshot.percentiles.p50);
    gauge('response_time_p95_ms', 'Response time p95 (ms)', snapshot.percentiles.p95);
    gauge('response_time_p99_ms', 'Response time p99 (ms)', snapshot.percentiles.p99);

    counter('requests_total', 'Total requests observed', snapshot.totalRequests);

    out += `# HELP ${p}_http_responses_total HTTP responses by status code\n# TYPE ${p}_http_responses_total counter\n`;
    for (const [code, count] of Object.entries(snapshot.statusCodes)) {
        out += line(`${p}_http_responses_total`, count, { code });
    }

    counter('rate_limit_blocked_total', 'Rate-limited requests', snapshot.rateLimitStats.blocked);
    gauge('database_connected', 'Database connectivity (1=up,0=down)', snapshot.database.connected ? 1 : 0);
    gauge('database_latency_ms', 'Database health-check latency (ms)', snapshot.database.latencyMs);

    if (typeof snapshot.workerCount === 'number') {
        gauge('cluster_workers', 'Active cluster workers', snapshot.workerCount);
    }

    // Aggregatable latency: a real histogram, labelled by route, so Prometheus
    // can compute quantiles across instances (the p50/p95/p99 gauges above are
    // per-instance and can't be averaged meaningfully). Per process: in cluster
    // mode each worker exposes its own, which is how Prometheus expects it.
    if (histograms.length > 0) {
        const name = `${p}_http_request_duration_seconds`;
        out += `# HELP ${name} HTTP request latency by method, route and status\n# TYPE ${name} histogram\n`;
        for (const h of histograms) {
            const labels = { method: h.method, route: h.route, status: String(h.status) };
            HISTOGRAM_BUCKETS_SECONDS.forEach((le, i) => {
                out += line(`${name}_bucket`, h.buckets[i] ?? 0, { ...labels, le: String(le) });
            });
            out += line(`${name}_bucket`, h.count, { ...labels, le: '+Inf' });
            out += line(`${name}_sum`, Math.round(h.sum * 1e6) / 1e6, labels);
            out += line(`${name}_count`, h.count, labels);
        }
    }

    return out;
}
