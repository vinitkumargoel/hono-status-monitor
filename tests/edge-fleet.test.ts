// Edge store: isolates persist from the request path, peer reads are capped
// and cached.
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createEdgeMonitor } from '../src/monitor-edge';
import { createRequestTrackingMiddleware } from '../src/request-tracking';
import type { StatusStore } from '../src/types';

function memoryStore() {
    const data = new Map<string, string>();
    const store: StatusStore & { data: Map<string, string> } = {
        data,
        get: vi.fn(async (k: string) => data.get(k) ?? null),
        put: vi.fn(async (k: string, v: string) => { data.set(k, v); }),
        list: vi.fn(async ({ prefix = '' } = {}) => ({ keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }))
    };
    return store;
}

describe('edge store', () => {
    it('persists from the request path via waitUntil, without anyone viewing the dashboard', async () => {
        const store = memoryStore();
        const monitor = createEdgeMonitor({ store, instanceId: 'a', logger: false });
        const app = new Hono();
        app.use('*', createRequestTrackingMiddleware(monitor));
        app.get('/x', (c) => c.text('x'));
        const pending: Promise<unknown>[] = [];
        const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
        await app.request('/x', {}, undefined, ctx as never);
        await Promise.all(pending);
        expect(pending).toHaveLength(1);
        expect(JSON.parse(store.data.get('hsm:inst:a')!).totalRequests).toBe(1);
    });

    it('does not throw when the runtime has no ExecutionContext', async () => {
        const store = memoryStore();
        const monitor = createEdgeMonitor({ store, instanceId: 'a', logger: false });
        const app = new Hono();
        app.use('*', createRequestTrackingMiddleware(monitor));
        app.get('/x', (c) => c.text('x'));
        expect((await app.request('/x')).status).toBe(200);
    });

    it('reads at most maxPeers peers and caches them between reads', async () => {
        const store = memoryStore();
        for (let i = 0; i < 5; i++) {
            store.data.set(`hsm:inst:peer${i}`, JSON.stringify({ totalRequests: 1, rps: 1, statusCodes: {} }));
        }
        const monitor = createEdgeMonitor({ store, instanceId: 'self', maxPeers: 2, logger: false });
        const first = await monitor.getMetricsSnapshot();
        expect(first.instanceCount).toBe(3);
        const reads = (store.get as ReturnType<typeof vi.fn>).mock.calls.length;
        await monitor.getMetricsSnapshot();
        expect((store.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads);
        expect((store.list as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    });
});
