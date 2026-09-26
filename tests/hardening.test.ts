import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { statusMonitor } from '../src/index';
import { statusMonitor as edgeStatusMonitor } from '../src/index-edge';
import { createMonitor } from '../src/monitor';
import { createEdgeMonitor, describeEdgeRuntime } from '../src/monitor-edge';
import { sanitizeConfig } from '../src/config';
import { isWorkerMetricsMessage } from '../src/cluster';
import { toPrometheus } from '../src/format';
import { generateDashboard } from '../src/dashboard';
import { DEFAULT_CHARTJS_URL, DEFAULT_SRI } from '../src/chart-cdn';
import { dashboardSecurityHeaders, scriptSourceFor } from '../src/security';
import type { MetricsSnapshot, StatusMonitorConfig } from '../src/types';

const silence = () => vi.spyOn(console, 'log').mockImplementation(() => {});

afterEach(() => vi.restoreAllMocks());

describe('config sanitizing', () => {
    const defaults = { pollingInterval: 1000, updateInterval: 1000, retentionSeconds: 60, maxRecentErrors: 10,
        maxRoutes: 10, maxTrackedRoutes: 1000, storeWriteInterval: 60000, healthCheckTimeout: 5000 } as Required<StatusMonitorConfig>;

    it('clamps too-small values and replaces non-finite ones, warning for each', () => {
        const warn = vi.fn();
        const out = sanitizeConfig({ ...defaults, updateInterval: 0, retentionSeconds: -5, maxTrackedRoutes: NaN }, defaults, warn);
        expect(out.updateInterval).toBe(100);
        expect(out.retentionSeconds).toBe(1);
        expect(out.maxTrackedRoutes).toBe(1000);
        expect(warn).toHaveBeenCalledTimes(3);
    });

    it('leaves valid config untouched and silent', () => {
        const warn = vi.fn();
        expect(sanitizeConfig(defaults, defaults, warn)).toEqual(defaults);
        expect(warn).not.toHaveBeenCalled();
    });

    it('is applied by both monitors', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const node = createMonitor({ retentionSeconds: -1 });
        const edge = createEdgeMonitor({ maxTrackedRoutes: 0 });
        expect(node.config.retentionSeconds).toBe(1);
        expect(edge.config.maxTrackedRoutes).toBe(1);
    });
});

describe('metrics interval', () => {
    it('does not keep the process alive', () => {
        silence();
        const spy = vi.spyOn(globalThis, 'setInterval');
        const monitor = createMonitor({});
        monitor.start();
        const handle = spy.mock.results[0]?.value as NodeJS.Timeout;
        expect(handle.hasRef()).toBe(false);
        monitor.stop();
    });
});

describe('health checks', () => {
    it('times out a hung check and reports it as down', async () => {
        const monitor = createEdgeMonitor({
            healthCheckTimeout: 20,
            healthChecks: { slow: () => new Promise(() => {}) }
        });
        const report = await monitor.getHealthReport();
        expect(report.status).toBe('degraded');
        expect(report.checks[0].connected).toBe(false);
        expect(String(report.checks[0].details?.error)).toMatch(/timed out/);
    });

    it('shares one run between concurrent callers and caches briefly', async () => {
        const check = vi.fn(async () => ({ connected: true, latencyMs: 1 }));
        const monitor = createEdgeMonitor({ healthChecks: { db: check } });
        await Promise.all([monitor.getHealthReport(), monitor.getHealthReport(), monitor.getHealthReport()]);
        await monitor.getHealthReport();
        expect(check).toHaveBeenCalledTimes(1);
    });

    it('flags whether any check was configured', async () => {
        expect((await createEdgeMonitor({}).getHealthReport()).configured).toBe(false);
        expect((await createEdgeMonitor({ healthCheck: async () => ({ connected: true, latencyMs: 0 }) })
            .getHealthReport()).configured).toBe(true);
    });
});

describe('error rate', () => {
    it('matches a full scan of tracked routes after eviction', async () => {
        const monitor = createEdgeMonitor({ maxTrackedRoutes: 2 });
        for (const [path, status] of [['/a', 500], ['/b', 200], ['/c', 404], ['/a', 500]] as const) {
            monitor.trackRequest(path, 'GET');
            monitor.trackRequestComplete(path, 'GET', 1, status);
        }
        // /a was evicted when /c arrived, then re-tracked: 1 error on /a, 1 on /c.
        const snapshot = await monitor.getMetricsSnapshot();
        expect(snapshot.errorRate).toBe(50);
    });
});

describe('cluster IPC validation', () => {
    const valid = { type: 'worker-metrics', workerId: 1, pid: 2, metrics: { rps: 1 }, charts: { cpu: [{ timestamp: 1, value: 2 }] } };

    it('accepts a well-formed message', () => {
        expect(isWorkerMetricsMessage(valid)).toBe(true);
    });

    it.each([
        ['wrong type', { ...valid, type: 'other' }],
        ['string metric', { ...valid, metrics: { rps: '1' } }],
        ['non-finite pid', { ...valid, pid: Infinity }],
        ['bad chart point', { ...valid, charts: { cpu: [{ timestamp: 'x', value: 1 }] } }],
        ['missing charts', { ...valid, charts: undefined }]
    ])('rejects %s', (_, msg) => {
        expect(isWorkerMetricsMessage(msg)).toBe(false);
    });
});

describe('prometheus label escaping', () => {
    it('strips carriage returns from label values', () => {
        const snapshot = { cpu: 0, memoryMB: 0, memoryPercent: 0, heapUsedMB: 0, heapTotalMB: 0, loadAvg: 0, uptime: 0,
            processUptime: 0, eventLoopLag: 0, activeConnections: 0, rps: 0, responseTime: 0, errorRate: 0,
            percentiles: { p50: 0, p95: 0, p99: 0, avg: 0 }, totalRequests: 1, statusCodes: { '200\r\nx 1': 1 },
            rateLimitStats: { blocked: 0, total: 0 }, database: { connected: true, latencyMs: 0 } } as unknown as MetricsSnapshot;
        const out = toPrometheus(snapshot);
        expect(out).not.toContain('\r');
        expect(out).toContain('code="200  x 1"');
    });
});

describe('dashboard security', () => {
    it('stamps SRI on the pinned CDN scripts only', () => {
        const pinned = generateDashboard({ title: 't', hostname: 'h', uptime: '1s' });
        expect(pinned).toContain(`integrity="${DEFAULT_SRI[DEFAULT_CHARTJS_URL]}"`);
        const custom = generateDashboard({ title: 't', hostname: 'h', uptime: '1s', chartjsUrl: '/chart.js', chartAdapterUrl: '/a.js' });
        expect(custom).not.toContain('integrity=');
    });

    it('builds script-src from the chart origins and the nonce', () => {
        const csp = dashboardSecurityHeaders('abc', [DEFAULT_CHARTJS_URL, '/self.js'])['Content-Security-Policy'];
        expect(csp).toContain("script-src 'nonce-abc' https://cdn.jsdelivr.net 'self'");
        expect(csp).toContain("frame-ancestors 'self'");
        expect(scriptSourceFor('javascript:alert(1)')).toBeNull();
        expect(scriptSourceFor('//evil.example/x.js')).toBeNull();
    });

    for (const [name, make] of [['node', statusMonitor], ['edge', edgeStatusMonitor]] as const) {
        it(`${name}: dashboard sends CSP whose nonce matches the inline script`, async () => {
            silence();
            const monitor = make({});
            const res = await monitor.routes.request('/');
            monitor.stop();
            const csp = res.headers.get('content-security-policy') ?? '';
            const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
            expect(nonce).toBeTruthy();
            const html = await res.text();
            expect(html).toContain(`<script nonce="${nonce}">`);
            expect(html).not.toContain('onclick=');
            expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
            expect(res.headers.get('cache-control')).toBe('no-store');
        });
    }

    it('omits the hardening headers when securityHeaders is false', async () => {
        silence();
        const monitor = edgeStatusMonitor({ securityHeaders: false });
        const res = await monitor.routes.request('/');
        expect(res.headers.get('content-security-policy')).toBeNull();
    });
});

describe('/api/metrics payload', () => {
    it('includes the health report alongside snapshot and charts', async () => {
        const monitor = edgeStatusMonitor({ healthChecks: { db: async () => ({ connected: true, latencyMs: 3 }) } });
        const app = new Hono().route('/status', monitor.routes);
        const body = await (await app.request('/status/api/metrics')).json() as { health: { checks: { name: string }[] } };
        expect(body.health.checks.map((c) => c.name)).toEqual(['db']);
    });
});

describe('edge runtime labelling', () => {
    afterEach(() => { delete (globalThis as { Deno?: unknown }).Deno; });

    it('keeps the Cloudflare label by default and names Deno when present', () => {
        expect(describeEdgeRuntime().label).toBe('Cloudflare Workers');
        (globalThis as { Deno?: unknown }).Deno = {};
        // detectPlatform() still reports node here (process exists), so Deno wins
        // only through the explicit global check.
        expect(describeEdgeRuntime()).toEqual({ hostname: 'deno', label: 'Deno' });
    });
});
