// The shared SSE broadcaster: one snapshot per tick for all clients, capped.
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { registerCommonRoutes } from '../src/routes';
import type { MetricsSnapshot, ChartData, HealthReport } from '../src/types';

function fakeMonitor(maxStreamClients = 100) {
    const getMetricsSnapshot = vi.fn(async () => ({ rps: 1, totalRequests: 1, statusCodes: {} }) as unknown as MetricsSnapshot);
    return {
        getMetricsSnapshot,
        config: { prometheus: false, prometheusPrefix: 'hono', pollingInterval: 250, maxStreamClients },
        getChartData: () => ({}) as ChartData,
        getHealthReport: async () => ({ status: 'ok', checks: [], uptime: 1, timestamp: 0 }) as HealthReport
    };
}

async function firstFrame(res: Response): Promise<string> {
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    return new TextDecoder().decode(value);
}

describe('/api/stream', () => {
    it('rejects clients beyond maxStreamClients with 503', async () => {
        const app = new Hono();
        registerCommonRoutes(app, fakeMonitor(1), { enableStream: true });
        const ctrl = new AbortController();
        const first = await app.request('/api/stream', { signal: ctrl.signal });
        expect(first.status).toBe(200);
        const second = await app.request('/api/stream');
        expect(second.status).toBe(503);
        ctrl.abort();
        await first.body?.cancel();
    });

    it('computes one snapshot per tick however many clients are connected', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        try {
            const monitor = fakeMonitor();
            const app = new Hono();
            registerCommonRoutes(app, monitor, { enableStream: true });
            const responses = await Promise.all([1, 2, 3, 4, 5].map(() => app.request('/api/stream')));
            for (const r of responses) expect(await firstFrame(r)).toMatch(/^data: /);
            monitor.getMetricsSnapshot.mockClear();
            // Streams were cancelled by firstFrame; reconnect five and tick once.
            const live = await Promise.all([1, 2, 3, 4, 5].map(() => app.request('/api/stream')));
            monitor.getMetricsSnapshot.mockClear();
            await vi.advanceTimersByTimeAsync(250);
            expect(monitor.getMetricsSnapshot).toHaveBeenCalledTimes(1);
            await Promise.all(live.map((r) => r.body?.cancel()));
        } finally {
            vi.useRealTimers();
        }
    });
});
