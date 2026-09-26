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
        const monitor = createMonitor({ logger, updateInterval: -1 });
        monitor.start();
        monitor.stop();
        expect(lines.some((l) => l.startsWith('warn') && l.includes('updateInterval'))).toBe(true);
        expect(lines).toContain('log 📊 Status monitor started');
    });

    it('is silent with logger: false', () => {
        const log = vi.spyOn(console, 'log');
        const warn = vi.spyOn(console, 'warn');
        const monitor = createMonitor({ logger: false, updateInterval: -1 });
        monitor.start();
        monitor.stop();
        expect(log).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('public-dashboard warning', () => {
    it('warns once in production when authorize is not set', () => {
        vi.stubEnv('NODE_ENV', 'production');
        const { lines, logger } = recorder();
        statusMonitor({ logger }).stop();
        expect(lines.filter((l) => l.includes('are public'))).toHaveLength(1);
    });

    it('stays quiet outside production or with authorize', () => {
        const { lines, logger } = recorder();
        statusMonitor({ logger }).stop();
        vi.stubEnv('NODE_ENV', 'production');
        statusMonitor({ logger, authorize: () => true }).stop();
        expect(lines.filter((l) => l.includes('are public'))).toHaveLength(0);
    });
});

describe('prometheus histogram', () => {
    it('exposes cumulative latency buckets per method, route and status', async () => {
        const monitor = statusMonitor({ logger: false, groupBy: 'route', prometheusHistogram: true });
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
        const monitor = statusMonitor({ logger: false });
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
