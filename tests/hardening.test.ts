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

    it('replaces unusable values with the default, warning for each', () => {
        const warn = vi.fn();
        const out = sanitizeConfig({ ...defaults, updateInterval: 0, retentionSeconds: -5, maxTrackedRoutes: NaN }, defaults, warn);
        expect(out.updateInterval).toBe(1000);
        expect(out.retentionSeconds).toBe(60);
        expect(out.maxTrackedRoutes).toBe(1000);
        expect(warn).toHaveBeenCalledTimes(3);
    });

    it('keeps small-but-valid values, zero where zero is meaningful, and numeric strings', () => {
        const warn = vi.fn();
        const out = sanitizeConfig({ ...defaults, updateInterval: 10, maxRoutes: 0, healthCheckTimeout: 0,
            retentionSeconds: '120' as unknown as number }, defaults, warn);
        expect(out).toMatchObject({ updateInterval: 10, maxRoutes: 0, healthCheckTimeout: 0, retentionSeconds: 120 });
        expect(warn).not.toHaveBeenCalled();
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
        expect(node.config.retentionSeconds).toBe(60);
        expect(edge.config.maxTrackedRoutes).toBe(1000);
    });

    it('treats explicitly undefined options as unset, silently', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const monitor = createMonitor({ healthCheck: undefined, pollingInterval: undefined, alerts: { cpu: undefined } });
        expect(monitor.config.pollingInterval).toBe(1000);
        expect(monitor.config.alerts.cpu).toBe(80);
        const report = await monitor.getHealthReport();
        expect(report).toMatchObject({ status: 'ok', configured: false });
        expect(warn).not.toHaveBeenCalled();
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
    it('has no timeout unless one is configured', () => {
        expect(createEdgeMonitor({}).config.healthCheckTimeout).toBe(0);
    });

    it('times out a hung check and reports it as down with the time waited', async () => {
        const monitor = createEdgeMonitor({
            healthCheckTimeout: 20,
            healthChecks: { slow: () => new Promise(() => {}) }
        });
        const report = await monitor.getHealthReport();
        expect(report.status).toBe('degraded');
        expect(report.checks[0].connected).toBe(false);
        expect(String(report.checks[0].details?.error)).toMatch(/timed out/);
        expect(report.checks[0].latencyMs).toBeGreaterThanOrEqual(15);
    });

    it('runs a single healthCheck once for both the report and the Node snapshot', async () => {
        const check = vi.fn(async () => ({ connected: true, latencyMs: 1, details: { poolSize: 4 } }));
        const monitor = createMonitor({ healthCheck: check });
        const [snapshot] = await Promise.all([monitor.getMetricsSnapshot(), monitor.getHealthReport()]);
        expect(check).toHaveBeenCalledTimes(1);
        expect(snapshot.database).toMatchObject({ connected: true, poolSize: 4, latencyMs: 1 });
        expect(snapshot.database.name).toBeUndefined();
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

describe('resetStats', () => {
    it('ignores completions of requests that were in flight at reset', async () => {
        const monitor = createEdgeMonitor({});
        monitor.trackRequest('/foo', 'GET');
        monitor.resetStats();
        monitor.trackRequestComplete('/foo', 'GET', 50, 500);
        const snapshot = await monitor.getMetricsSnapshot();
        expect(snapshot.statusCodes).toEqual({});
        expect(snapshot.totalRequests).toBe(0);
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

    const page = 'https://app.example/status';

    it('builds script-src from the chart origins and the nonce', () => {
        const csp = dashboardSecurityHeaders('abc', [DEFAULT_CHARTJS_URL, '/self.js'], page)['Content-Security-Policy'];
        expect(csp).toContain("script-src 'nonce-abc' https://cdn.jsdelivr.net 'self'");
        expect(csp).toContain("frame-ancestors 'self'");
    });

    it('resolves relative and protocol-relative chart URLs against the page', () => {
        expect(scriptSourceFor('static/chart.js', page)).toBe("'self'");
        expect(scriptSourceFor('//cdn.example/chart.js', page)).toBe('https://cdn.example');
        expect(scriptSourceFor('javascript:alert(1)', page)).toBeNull();
        expect(scriptSourceFor('/\\evil.example/x.js', page)).toBeNull();
    });

    it('sends no CSP rather than one that would block an unexpressible script URL', () => {
        const headers = dashboardSecurityHeaders('abc', ['data:text/javascript,1'], page);
        expect(headers['Content-Security-Policy']).toBeUndefined();
        expect(headers['X-Content-Type-Options']).toBe('nosniff');
    });

    for (const [name, make] of [['node', statusMonitor], ['edge', edgeStatusMonitor]] as const) {
        it(`${name}: by default sends only the always-safe headers`, async () => {
            silence();
            const monitor = make({});
            const res = await monitor.routes.request('/');
            monitor.stop();
            expect(res.headers.get('content-security-policy')).toBeNull();
            expect(res.headers.get('x-frame-options')).toBeNull();
            expect(res.headers.get('x-content-type-options')).toBe('nosniff');
            expect(res.headers.get('cache-control')).toBe('no-store');
        });

        it(`${name}: securityHeaders sends a CSP whose nonce matches the inline script`, async () => {
            silence();
            const monitor = make({ securityHeaders: true });
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


});

describe('/api/metrics payload', () => {
    it('includes the health report when checks are configured', async () => {
        const monitor = edgeStatusMonitor({ healthChecks: { db: async () => ({ connected: true, latencyMs: 3 }) } });
        const app = new Hono().route('/status', monitor.routes);
        const body = await (await app.request('/status/api/metrics')).json() as { health: { checks: { name: string }[] } };
        expect(body.health.checks.map((c) => c.name)).toEqual(['db']);
        monitor.stop();
    });

    it('omits health, and runs no checks, when none are configured', async () => {
        const monitor = edgeStatusMonitor({});
        const body = await (await monitor.routes.request('/api/metrics')).json() as Record<string, unknown>;
        expect(body).not.toHaveProperty('health');
        expect(body).toHaveProperty('snapshot');
        monitor.stop();
    });

    it('reuses dashboard health for at least 5 s across polls', async () => {
        const check = vi.fn(async () => ({ connected: true, latencyMs: 1 }));
        const monitor = edgeStatusMonitor({ healthChecks: { db: check } });
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            await monitor.routes.request('/api/metrics');
            vi.setSystemTime(Date.now() + 3000);
            await monitor.routes.request('/api/metrics');
            expect(check).toHaveBeenCalledTimes(1);
            vi.setSystemTime(Date.now() + 3000);
            await monitor.routes.request('/api/metrics');
            expect(check).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
            monitor.stop();
        }
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
