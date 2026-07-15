// =============================================================================
// HONO STATUS MONITOR - SHARED FORMATTERS
// HTML escaping and Prometheus/OpenMetrics exposition
// =============================================================================

import type { MetricsSnapshot } from './types.js';

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

function sanitizeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
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
export function toPrometheus(snapshot: MetricsSnapshot, prefix = 'hono'): string {
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

    gauge('cpu_percent', 'CPU usage percentage', snapshot.cpu);
    gauge('memory_used_bytes', 'System memory used in bytes', snapshot.memoryMB * 1024 * 1024);
    gauge('memory_percent', 'System memory used percentage', snapshot.memoryPercent);
    gauge('heap_used_bytes', 'Heap used in bytes', snapshot.heapUsedMB * 1024 * 1024);
    gauge('heap_total_bytes', 'Heap total in bytes', snapshot.heapTotalMB * 1024 * 1024);
    gauge('load_average', 'System 1-minute load average', snapshot.loadAvg);
    gauge('uptime_seconds', 'System uptime in seconds', snapshot.uptime);
    gauge('process_uptime_seconds', 'Process uptime in seconds', snapshot.processUptime);
    gauge('event_loop_lag_ms', 'Event loop lag in milliseconds', snapshot.eventLoopLag);
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

    return out;
}
