import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { registerCommonRoutes, createAuthGuard } from '../src/routes';
import type { MetricsSnapshot, ChartData, HealthReport } from '../src/types';

function fakeMonitor(over: Partial<{ prometheus: boolean }> = {}) {
    const snapshot = { rps: 1, totalRequests: 1, statusCodes: {} } as unknown as MetricsSnapshot;
    const charts = { cpu: [], rps: [] } as unknown as ChartData;
    return {
        config: {
            prometheus: over.prometheus ?? true,
            prometheusPrefix: 'hono',
            pollingInterval: 250
        },
        getMetricsSnapshot: async () => snapshot,
        getChartData: () => charts,
        getHealthReport: async (): Promise<HealthReport> => ({ status: 'ok', checks: [], uptime: 1, timestamp: 0 })
    };
}

describe('createAuthGuard', () => {
    it('returns null when no authorize is configured', () => {
        expect(createAuthGuard(undefined)).toBeNull();
    });

    it('401s on a falsy or throwing authorize', async () => {
        const app = new Hono();
        const guard = createAuthGuard(() => { throw new Error('boom'); });
        app.use('*', guard!);
        app.get('/x', (c) => c.text('ok'));
        const res = await app.request('/x');
        expect(res.status).toBe(401);
    });
});

describe('/api/stream SSE', () => {
    it('emits an event-stream frame with a data payload', async () => {
        const app = new Hono();
        registerCommonRoutes(app, fakeMonitor(), { enableStream: true });
        const res = await app.request('/api/stream');
        expect(res.headers.get('Content-Type')).toContain('text/event-stream');

        const reader = res.body!.getReader();
        const { value } = await reader.read();
        const text = new TextDecoder().decode(value);
        expect(text.startsWith('data: ')).toBe(true);
        expect(text).toContain('"snapshot"');
        await reader.cancel(); // triggers cleanup(); no timer left running
    });

    it('closes immediately when the request is already aborted', async () => {
        const app = new Hono();
        registerCommonRoutes(app, fakeMonitor(), { enableStream: true });
        const ac = new AbortController();
        ac.abort();
        const res = await app.request('/api/stream', { signal: ac.signal });
        const reader = res.body!.getReader();
        // An aborted request must not hang; the stream ends right away.
        const { done } = await reader.read();
        expect(done).toBe(true);
    });

    it('is not registered when enableStream is false', async () => {
        const app = new Hono();
        registerCommonRoutes(app, fakeMonitor(), { enableStream: false });
        const res = await app.request('/api/stream');
        expect(res.status).toBe(404);
    });
});
