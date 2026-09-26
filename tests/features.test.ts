import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMonitor } from '../src/monitor';
import { createEdgeMonitor } from '../src/monitor-edge';
import { createClusterAggregator } from '../src/cluster';
import { defaultNormalizePath } from '../src/metrics-utils';
import { escapeHtml, toPrometheus } from '../src/format';
import { generateDashboard } from '../src/dashboard';
import type { MetricsSnapshot, RouteStats } from '../src/types';

describe('defaultNormalizePath', () => {
    it('collapses whole numeric segments but not digit-prefixed words', () => {
        expect(defaultNormalizePath('/users/42/posts')).toBe('/users/:id/posts');
        // Regression: /2fa must not become /:idfa
        expect(defaultNormalizePath('/2fa/verify')).toBe('/2fa/verify');
        expect(defaultNormalizePath('/v1/users/99')).toBe('/v1/users/:id');
    });
});

describe('escapeHtml', () => {
    it('neutralizes HTML-significant characters', () => {
        expect(escapeHtml('<img src=x onerror=alert(1)>'))
            .toBe('&lt;img src=x onerror=alert(1)&gt;');
        expect(escapeHtml(`a"b'c&d`)).toBe('a&quot;b&#39;c&amp;d');
    });
});

describe('dashboard XSS safety', () => {
    it('escapes the title and hostname it renders server-side', () => {
        const html = generateDashboard({
            title: '</title><script>alert(1)</script>',
            hostname: '<b>host</b>',
            uptime: '1s'
        });
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(html).toContain('&lt;b&gt;host&lt;/b&gt;');
    });

    it('ships a client-side escaper for route/error rendering', () => {
        const html = generateDashboard({ title: 't', hostname: 'h', uptime: '1s' });
        expect(html).toContain('function esc(');
        expect(html).toContain('esc(r.path)');
    });

    it('honors a custom polling interval', () => {
        const html = generateDashboard({ title: 't', hostname: 'h', uptime: '1s', pollingInterval: 4000 });
        expect(html).toContain('var INTERVAL = 4000;');
    });
});

describe('route tracking cap', () => {
    it('evicts least-recently-used routes past maxTrackedRoutes', async () => {
        const monitor = createEdgeMonitor({ maxTrackedRoutes: 3 });
        for (let i = 0; i < 8; i++) {
            monitor.trackRequest(`/r${i}`, 'GET');
            monitor.trackRequestComplete(`/r${i}`, 'GET', 10, 200);
        }
        const snap = await monitor.getMetricsSnapshot();
        expect(snap.topRoutes.length).toBe(3);
    });
});

describe('monitor restart lifecycle', () => {
    it('survives a stop() then start() cycle and still reports metrics', async () => {
        const monitor = createMonitor({ updateInterval: 10_000 });
        monitor.start();
        monitor.stop();
        // Re-arming: instrumentation must come back rather than staying disabled.
        monitor.start();
        const snap = await monitor.getMetricsSnapshot();
        expect(Number.isFinite(snap.eventLoopLag)).toBe(true);
        expect(snap.eventLoopLag).toBeGreaterThanOrEqual(0);
        monitor.stop();
    });
});

describe('toPrometheus', () => {
    it('emits scrapeable gauge/counter lines with the given prefix', async () => {
        const monitor = createEdgeMonitor({});
        monitor.trackRequest('/x', 'GET');
        monitor.trackRequestComplete('/x', 'GET', 12, 200);
        const snapshot = await monitor.getMetricsSnapshot();
        const text = toPrometheus(snapshot, 'myapp');

        expect(text).toContain('# TYPE myapp_requests_total counter');
        expect(text).toContain('myapp_requests_total 1');
        expect(text).toContain('myapp_http_responses_total{code="200"} 1');
        expect(text).toContain('# TYPE myapp_rps gauge');
    });
});

describe('health report', () => {
    it('reports degraded when any named check fails', async () => {
        const monitor = createEdgeMonitor({
            healthChecks: {
                db: async () => ({ connected: true, latencyMs: 1 }),
                cache: async () => ({ connected: false, latencyMs: 0 })
            }
        });
        const report = await monitor.getHealthReport();
        expect(report.status).toBe('degraded');
        expect(report.checks).toHaveLength(2);
        expect(report.checks.find(c => c.name === 'cache')?.connected).toBe(false);
    });

    it('reports ok when the single healthCheck passes', async () => {
        const monitor = createEdgeMonitor({
            healthCheck: async () => ({ connected: true, latencyMs: 2, name: 'primary' })
        });
        const report = await monitor.getHealthReport();
        expect(report.status).toBe('ok');
        expect(report.checks[0].name).toBe('primary');
    });
});

describe('resetStats', () => {
    it('clears accumulated counters', async () => {
        const monitor = createEdgeMonitor({});
        monitor.trackRequest('/x', 'GET');
        monitor.trackRequestComplete('/x', 'GET', 10, 500);
        monitor.resetStats();
        const snap = await monitor.getMetricsSnapshot();
        expect(snap.totalRequests).toBe(0);
        expect(snap.topRoutes).toHaveLength(0);
        expect(snap.recentErrors).toHaveLength(0);
    });
});

describe('cluster route de-duplication', () => {
    it('does not double-count a route present in multiple lists', () => {
        const aggregator = createClusterAggregator();
        const route: RouteStats = {
            path: '/a', method: 'GET', count: 10, totalTime: 100, avgTime: 10,
            minTime: 5, maxTime: 20, errors: 2, lastAccess: 1
        };
        aggregator.updateWorkerMetrics({
            type: 'worker-metrics',
            workerId: 1,
            pid: 1,
            // Same route object surfaced in both top and slowest lists.
            metrics: { topRoutes: [route], slowestRoutes: [route], errorRoutes: [route] },
            charts: {} as any
        });

        const base = { statusCodes: {}, topRoutes: [], slowestRoutes: [], errorRoutes: [] } as unknown as MetricsSnapshot;
        const agg = aggregator.aggregateMetrics(base);
        const merged = agg.topRoutes.find(r => r.path === '/a');
        expect(merged?.count).toBe(10); // not 30
        expect(merged?.errors).toBe(2); // not 6
    });
});

describe('onAlert transitions (fake timers)', () => {
    afterEach(() => vi.useRealTimers());

    it('fires once when an alert becomes active', async () => {
        vi.useFakeTimers();
        const events: string[] = [];
        const monitor = createMonitor({
            updateInterval: 1000,
            alerts: { errorRate: 1 },
            onAlert: (e) => events.push(`${e.metric}:${e.active}`)
        });
        monitor.start();

        monitor.trackRequest('/boom', 'GET');
        monitor.trackRequestComplete('/boom', 'GET', 5, 500);

        await vi.advanceTimersByTimeAsync(1000);
        monitor.stop();

        expect(events).toContain('errorRate:true');
    });
});
