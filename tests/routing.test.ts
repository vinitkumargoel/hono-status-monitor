// groupBy, ignorePaths and sampleRate: which requests are tracked, and how.
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createEdgeMonitor } from '../src/monitor-edge';
import { createRequestTrackingMiddleware, compileIgnore } from '../src/request-tracking';
import type { StatusMonitorConfig } from '../src/types';

function appWith(config: StatusMonitorConfig) {
    const monitor = createEdgeMonitor({ logger: false, ...config });
    const app = new Hono();
    app.use('*', createRequestTrackingMiddleware(monitor));
    app.get('/users/:id', (c) => c.text('u'));
    app.get('/api/v1/orgs/:org/users/:id/posts', (c) => c.text('p'));
    const sub = new Hono();
    sub.get('/items/:itemId', (c) => c.text('i'));
    app.route('/shop', sub);
    return { app, monitor };
}

const paths = async (monitor: ReturnType<typeof createEdgeMonitor>) =>
    (await monitor.getMetricsSnapshot()).topRoutes.map((r) => `${r.method} ${r.path} ${r.count}`).sort();

describe('groupBy', () => {
    it("'route' groups by the matched Hono pattern at any depth, including sub-apps", async () => {
        const { app, monitor } = appWith({ groupBy: 'route' });
        await app.request('/users/1');
        await app.request('/users/abc');
        await app.request('/api/v1/orgs/acme/users/7/posts');
        await app.request('/shop/items/sku-9');
        expect(await paths(monitor)).toEqual([
            'GET /api/v1/orgs/:org/users/:id/posts 1',
            'GET /shop/items/:itemId 1',
            'GET /users/:id 2'
        ]);
    });

    it("'route' falls back to the normalized path for requests no route matched", async () => {
        const { app, monitor } = appWith({ groupBy: 'route' });
        await app.request('/missing/42');
        expect(await paths(monitor)).toEqual(['GET /missing/:id 1']);
    });

    it("'path' (default) keeps the previous normalization", async () => {
        const { app, monitor } = appWith({});
        await app.request('/users/1');
        await app.request('/users/abc');
        expect(await paths(monitor)).toEqual(['GET /users/:id 1', 'GET /users/abc 1']);
    });
});

describe('ignorePaths', () => {
    it('supports exact strings, /* prefixes, RegExps and predicates', () => {
        const match = compileIgnore(['/favicon.ico', '/assets/*', /^\/healthz?$/])!;
        expect(['/favicon.ico', '/assets', '/assets/app.js', '/health', '/healthz'].every(match)).toBe(true);
        expect(['/favicon.icon', '/assetsx', '/api/health'].some(match)).toBe(false);
        expect(compileIgnore((p) => p.startsWith('/x'))!('/xyz')).toBe(true);
        expect(compileIgnore([])).toBeNull();
    });

    it('leaves ignored requests out of every metric', async () => {
        const { app, monitor } = appWith({ ignorePaths: ['/users/*'] });
        await app.request('/users/1');
        await app.request('/shop/items/1');
        const s = await monitor.getMetricsSnapshot();
        expect(s.totalRequests).toBe(1);
        expect(s.topRoutes.map((r) => r.path)).toEqual(['/shop/items/:id']);
    });
});

describe('sampleRate', () => {
    it('at 0 still counts requests, status codes and errors but records no timing', async () => {
        const monitor = createEdgeMonitor({ sampleRate: 0, logger: false });
        const app = new Hono();
        app.use('*', createRequestTrackingMiddleware(monitor));
        app.get('/ok', (c) => c.text('ok'));
        app.get('/bad', (c) => c.text('no', 500));
        await app.request('/ok');
        await app.request('/bad');
        const s = await monitor.getMetricsSnapshot();
        expect(s.totalRequests).toBe(2);
        expect(s.statusCodes).toEqual({ '200': 1, '500': 1 });
        expect(s.errorRate).toBe(50);
        expect(s.topRoutes).toEqual([]);
        expect(s.percentiles.p50).toBe(0);
    });

    it('rejects values outside 0..1', () => {
        expect(() => createEdgeMonitor({ sampleRate: 2 })).toThrow(/sampleRate must be a number from 0 to 1/);
    });
});
