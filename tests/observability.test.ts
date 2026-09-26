// Logger, production warning, Prometheus histograms, required/optional checks.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { statusMonitor } from '../src/index-edge';
import { createEdgeMonitor } from '../src/monitor-edge';
import { createMonitor } from '../src/monitor';
import { toPrometheus } from '../src/format';

const recorder = () => {
    const lines: string[] = [];
    return { lines, logger: { log: (m: string) => lines.push(`log ${m}`), warn: (m: string) => lines.push(`warn ${m}`), error: (m: string) => lines.push(`error ${m}`) } };
};

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('logger', () => {
    it('routes the monitor\'s own messages through the given logger', () => {
        const { lines, logger } = recorder();
        const monitor = createMonitor({ logger });
        monitor.start();
        monitor.stop();
        expect(lines).toContain('log 📊 Status monitor started');
        statusMonitor({ logger });
        expect(lines.some((l) => l.startsWith('warn') && l.includes('closed until you configure access'))).toBe(true);
    });

    it('is silent with logger: false', () => {
        const log = vi.spyOn(console, 'log');
        const warn = vi.spyOn(console, 'warn');
        const monitor = createMonitor({ logger: false });
        monitor.start();
        monitor.stop();
        statusMonitor({ logger: false });
        expect(log).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('access control', () => {
    const mounted = (config: Parameters<typeof statusMonitor>[0]) => {
        const monitor = statusMonitor({ logger: false, ...config });
        return new Hono().route('/status', monitor.routes);
    };

    it('closes every status route when neither authorize nor publicAccess is set', async () => {
        const app = mounted({});
        for (const path of ['/status', '/status/api/metrics', '/status/health', '/status/prometheus']) {
            expect((await app.request(path)).status).toBe(403);
        }
    });

    it('serves them with publicAccess, or to requests authorize accepts', async () => {
        expect((await mounted({ publicAccess: true }).request('/status/health')).status).toBe(200);
        const guarded = mounted({ authorize: (c) => c.req.header('x-token') === 't' });
        expect((await guarded.request('/status/health')).status).toBe(401);
        expect((await guarded.request('/status/health', { headers: { 'x-token': 't' } })).status).toBe(200);
    });

    it('warns once at construction when access is not configured', () => {
        const { lines, logger } = recorder();
        statusMonitor({ logger });
        statusMonitor({ logger, publicAccess: true });
        statusMonitor({ logger, authorize: () => true });
        expect(lines.filter((l) => l.includes('closed until you configure access'))).toHaveLength(1);
    });
});

describe('prometheus histogram', () => {
    it('exposes cumulative latency buckets per method, route and status', async () => {
        const monitor = statusMonitor({ publicAccess: true, logger: false, groupBy: 'route', prometheusHistogram: true });
        const app = new Hono();
        app.use('*', monitor.middleware);
        app.route('/status', monitor.routes);
        app.get('/users/:id', (c) => c.text('u'));
        await app.request('/users/1');
        await app.request('/users/2');
        const text = await (await app.request('/status/prometheus')).text();
        const base = 'hono_http_request_duration_seconds';
        expect(text).toContain(`# TYPE ${base} histogram`);
        expect(text).toContain(`${base}_bucket{method="GET",route="/users/:id",status="200",le="+Inf"} 2`);
        expect(text).toContain(`${base}_count{method="GET",route="/users/:id",status="200"} 2`);
        expect(text).toMatch(new RegExp(`${base}_bucket\\{[^}]*le="10"\\} 2`));
    });

    it('is off unless prometheusHistogram is set', async () => {
        const monitor = statusMonitor({ publicAccess: true, logger: false });
        const app = new Hono();
        app.use('*', monitor.middleware);
        app.route('/status', monitor.routes);
        app.get('/x', (c) => c.text('x'));
        await app.request('/x');
        expect(await (await app.request('/status/prometheus')).text()).not.toContain('duration_seconds');
    });

    it('does not even collect histograms when the option is off', () => {
        const off = createEdgeMonitor({ logger: false });
        off.endRequest('/x', 'GET', 5, 200, false);
        expect(off.getHistograms()).toEqual([]);
        const on = createEdgeMonitor({ logger: false, prometheusHistogram: true });
        on.endRequest('/x', 'GET', 5, 200, false);
        expect(on.getHistograms()).toHaveLength(1);
    });

    it('emits nothing extra when there are no histograms', () => {
        const snapshot = { cpu: 0, memoryMB: 0, memoryPercent: 0, heapUsedMB: 0, heapTotalMB: 0, loadAvg: 0, uptime: 0,
            processUptime: 0, eventLoopLag: 0, activeConnections: 0, rps: 0, responseTime: 0, errorRate: 0,
            percentiles: { p50: 0, p95: 0, p99: 0, avg: 0 }, totalRequests: 0, statusCodes: {},
            rateLimitStats: { blocked: 0, total: 0 }, database: { connected: true, latencyMs: 0 } } as never;
        expect(toPrometheus(snapshot)).not.toContain('duration_seconds');
    });
});

describe('health check definitions', () => {
    it('reports optional checks without degrading /health', async () => {
        const monitor = createEdgeMonitor({
            logger: false,
            healthChecks: {
                db: async () => ({ connected: true, latencyMs: 1 }),
                cache: { check: async () => ({ connected: false, latencyMs: 1 }), required: false }
            }
        });
        const report = await monitor.getHealthReport();
        expect(report.status).toBe('ok');
        expect(report.checks.find((c) => c.name === 'cache')).toMatchObject({ connected: false, required: false });
        expect(report.checks.find((c) => c.name === 'db')).not.toHaveProperty('required');
    });

    it('applies a per-check timeout over the global one', async () => {
        const monitor = createEdgeMonitor({
            logger: false,
            healthCheckTimeout: 0,
            healthChecks: { slow: { check: () => new Promise(() => {}), timeoutMs: 20 } }
        });
        const report = await monitor.getHealthReport();
        expect(report.status).toBe('degraded');
        expect(String(report.checks[0].details?.error)).toMatch(/timed out after 20ms/);
    });
});

describe('prometheus system gauges', () => {
    it('are omitted on edge, where they would always be zero', async () => {
        const edge = await (await statusMonitor({ publicAccess: true, logger: false }).routes.request('/prometheus')).text();
        expect(edge).not.toContain('hono_cpu_percent');
        expect(edge).not.toContain('hono_heap_used_bytes');
        expect(edge).not.toContain('hono_event_loop_lag_ms');
        expect(edge).toContain('hono_requests_total');
    });

    it('are kept on Node', () => {
        const monitor = createMonitor({ logger: false });
        return monitor.getMetricsSnapshot().then((s) => {
            expect(toPrometheus(s)).toContain('hono_cpu_percent');
        });
    });
});
