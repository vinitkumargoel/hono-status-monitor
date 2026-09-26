// The public handle returned by statusMonitor({ publicAccess: true }): every method, on both entries.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { statusMonitor } from '../src/index';
import { statusMonitor as edgeStatusMonitor, statusMonitorEdge } from '../src/index-edge';
import defaultEdge from '../src/index-edge';

afterEach(() => vi.restoreAllMocks());

describe.each([
    ['node', statusMonitor, false],
    ['edge', edgeStatusMonitor, true]
] as const)('%s handle', (_, make, edge) => {
    it('tracks traffic through the middleware and exposes it on every accessor', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const monitor = make({ path: '/status', publicAccess: true });
        const app = new Hono();
        app.use('*', monitor.middleware);
        app.route('/status', monitor.routes);
        app.get('/ok', (c) => c.text('ok'));
        app.get('/boom', (c) => c.text('no', 500));

        await app.request('/ok');
        await app.request('/boom');
        await app.request('/status/api/metrics'); // not self-tracked

        const snapshot = await monitor.getMetrics();
        expect(snapshot.totalRequests).toBe(2);
        expect(snapshot.statusCodes).toMatchObject({ '200': 1, '500': 1 });
        expect(monitor.isEdgeMode).toBe(edge);
        expect(monitor.getCharts()).toHaveProperty('rps');
        expect((await monitor.getHealth()).status).toBe('ok');

        monitor.trackRateLimit(true);
        monitor.trackRateLimit(false);
        expect((await monitor.getMetrics()).rateLimitStats).toEqual({ blocked: 1, total: 2 });

        monitor.resetStats();
        expect((await monitor.getMetrics()).totalRequests).toBe(0);
        monitor.stop();
    });

    it('serves prometheus, health and a 401 behind authorize', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const monitor = make({ authorize: (c) => c.req.header('x-token') === 't' });
        const denied = await monitor.routes.request('/health');
        expect(denied.status).toBe(401);
        const prom = await monitor.routes.request('/prometheus', { headers: { 'x-token': 't' } });
        expect(prom.status).toBe(200);
        expect(await prom.text()).toContain('hono_requests_total');
        monitor.stop();
    });
});

describe('edge entry aliases', () => {
    it('exports statusMonitorEdge and a default that build edge monitors', () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        expect(statusMonitorEdge({ publicAccess: true }).isEdgeMode).toBe(true);
        expect(defaultEdge({}).isEdgeMode).toBe(true);
    });
});

describe('statusMonitor platform branch', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('builds the edge monitor when not running on Node or Bun', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
        vi.stubGlobal('process', { versions: {}, env: {} });
        const { statusMonitor: fresh } = await import('../src/index');
        expect(fresh({}).isEdgeMode).toBe(true);
    });
});

describe('lifecycle', () => {
    it('has no side effects until the first request, and stop() sticks until start()', async () => {
        const spy = vi.spyOn(globalThis, 'setInterval');
        const fresh = statusMonitor({ publicAccess: true, logger: false });
        expect(spy).not.toHaveBeenCalled();

        const app = new Hono();
        app.use('*', fresh.middleware);
        app.get('/x', (c) => c.text('x'));
        await app.request('/x');
        await app.request('/x');
        expect(spy).toHaveBeenCalledTimes(1);

        fresh.stop();
        await app.request('/x');
        expect(spy).toHaveBeenCalledTimes(1);

        fresh.start();
        expect(spy).toHaveBeenCalledTimes(2);
        fresh.stop();
    });

    it('starts when a status route is hit first', async () => {
        const spy = vi.spyOn(globalThis, 'setInterval');
        const monitor = statusMonitor({ publicAccess: true, logger: false });
        await monitor.routes.request('/health');
        expect(spy).toHaveBeenCalledTimes(1);
        monitor.stop();
    });
});

describe('lazy start triggers', () => {
    it('starts on the first metrics read, but not on a refused status request', async () => {
        const spy = vi.spyOn(globalThis, 'setInterval');
        const closed = statusMonitor({ logger: false });
        expect((await closed.routes.request('/health')).status).toBe(403);
        expect(spy).not.toHaveBeenCalled();
        await closed.getMetrics();
        expect(spy).toHaveBeenCalledTimes(1);
        closed.stop();
    });
});
