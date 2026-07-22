import { describe, it, expect } from 'vitest';
import { mergeSnapshots, persistSnapshot, loadPeerSnapshots, generateInstanceId } from '../src/edge-store';
import { createEdgeMonitor } from '../src/monitor-edge';
import type { MetricsSnapshot, RouteStats, StatusStore } from '../src/types';

// In-memory KV double implementing the StatusStore contract.
function fakeStore(): StatusStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
        data,
        async get(key) { return data.has(key) ? data.get(key)! : null; },
        async put(key, value) { data.set(key, value); },
        async list({ prefix } = {}) {
            return { keys: [...data.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) };
        }
    };
}

function snap(over: Partial<MetricsSnapshot>): MetricsSnapshot {
    return {
        timestamp: 0, cpu: 0, memoryMB: 0, memoryPercent: 0, heapUsedMB: 0, heapTotalMB: 0,
        loadAvg: 0, uptime: 0, processUptime: 0, responseTime: 0, rps: 0, statusCodes: {},
        totalRequests: 0, activeConnections: 0, eventLoopLag: 0, hostname: 'w', platform: 'x',
        nodeVersion: 'N/A', pid: 0, cpuCount: 0,
        percentiles: { p50: 0, p95: 0, p99: 0, avg: 0 },
        topRoutes: [], slowestRoutes: [], errorRoutes: [], recentErrors: [],
        alerts: { cpu: false, memory: false, responseTime: false, errorRate: false, eventLoopLag: false },
        gc: { collections: 0, pauseTimeMs: 0, heapGrowthRate: 0 },
        database: { connected: false, poolSize: 0, availableConnections: 0, waitQueueSize: 0, latencyMs: 0 },
        rateLimitStats: { blocked: 0, total: 0 }, errorRate: 0, isEdgeMode: true,
        ...over
    };
}

const route = (over: Partial<RouteStats>): RouteStats => ({
    path: '/a', method: 'GET', count: 1, totalTime: 10, avgTime: 10, minTime: 10, maxTime: 10, errors: 0, lastAccess: 1, ...over
});

describe('generateInstanceId', () => {
    it('returns a non-empty unique-ish id', () => {
        const a = generateInstanceId();
        expect(typeof a).toBe('string');
        expect(a.length).toBeGreaterThan(0);
    });
});

describe('mergeSnapshots', () => {
    it('returns base with instanceCount 1 when no peers', () => {
        const s = snap({ totalRequests: 5 });
        const merged = mergeSnapshots(s, []);
        expect(merged.totalRequests).toBe(5);
        expect(merged.instanceCount).toBe(1);
    });

    it('sums totals and averages rates across isolates', () => {
        const a = snap({ rps: 10, totalRequests: 100, activeConnections: 2, responseTime: 20, errorRate: 4, statusCodes: { '200': 100 } });
        const b = snap({ rps: 30, totalRequests: 300, activeConnections: 4, responseTime: 40, errorRate: 8, statusCodes: { '200': 300, '500': 5 } });
        const merged = mergeSnapshots(a, [b]);
        expect(merged.rps).toBe(40);
        expect(merged.totalRequests).toBe(400);
        expect(merged.activeConnections).toBe(6);
        expect(merged.responseTime).toBe(30); // avg
        expect(merged.errorRate).toBe(6);     // avg
        expect(merged.statusCodes['200']).toBe(400);
        expect(merged.statusCodes['500']).toBe(5);
        expect(merged.instanceCount).toBe(2);
    });

    it('merges overlapping routes without double counting within an isolate', () => {
        const r = route({ path: '/x', count: 10, totalTime: 100, errors: 2 });
        // Same route appears in top + slowest lists of the same snapshot.
        const a = snap({ topRoutes: [r], slowestRoutes: [r] });
        const b = snap({ topRoutes: [route({ path: '/x', count: 5, totalTime: 50, errors: 1 })] });
        const merged = mergeSnapshots(a, [b]);
        const x = merged.topRoutes.find((t) => t.path === '/x');
        expect(x?.count).toBe(15); // 10 (once) + 5, not 20 + 5
        expect(x?.errors).toBe(3);
    });

    it('honors the maxRoutes limit instead of a hardcoded 10', () => {
        const many = Array.from({ length: 25 }, (_, i) =>
            route({ path: `/r${i}`, count: 100 - i, totalTime: 10, errors: 1 })
        );
        const a = snap({ topRoutes: many });
        const b = snap({ topRoutes: [route({ path: '/rx', count: 999 })] });
        const merged = mergeSnapshots(a, [b], { maxRoutes: 20, maxRecentErrors: 5 });
        expect(merged.topRoutes).toHaveLength(20);
        expect(merged.errorRoutes.length).toBeLessThanOrEqual(20);
    });
});

describe('persist + load round-trip', () => {
    it('stores and reads back peer snapshots, excluding self', async () => {
        const store = fakeStore();
        await persistSnapshot(store, 'self', snap({ totalRequests: 1 }), 120);
        await persistSnapshot(store, 'peer1', snap({ totalRequests: 2 }), 120);
        await persistSnapshot(store, 'peer2', snap({ totalRequests: 3 }), 120);

        const peers = await loadPeerSnapshots(store, 'self');
        expect(peers).toHaveLength(2);
        expect(peers.map((p) => p.totalRequests).sort()).toEqual([2, 3]);
    });

    it('skips malformed / foreign entries under the key prefix', async () => {
        const store = fakeStore();
        await persistSnapshot(store, 'good', snap({ totalRequests: 7 }), 120);
        // A stray write sharing the prefix but not a valid snapshot.
        store.data.set('hsm:inst:junk', JSON.stringify({ hello: 'world' }));
        store.data.set('hsm:inst:broken', '{not json');

        const peers = await loadPeerSnapshots(store, 'self');
        expect(peers).toHaveLength(1);
        expect(peers[0].totalRequests).toBe(7);
    });

    it('never throws when the store fails', async () => {
        const brokenStore: StatusStore = {
            get: async () => { throw new Error('down'); },
            put: async () => { throw new Error('down'); },
            list: async () => { throw new Error('down'); }
        };
        await expect(persistSnapshot(brokenStore, 'x', snap({}), 120)).resolves.toBeUndefined();
        await expect(loadPeerSnapshots(brokenStore, 'x')).resolves.toEqual([]);
    });
});

describe('edge monitor with store', () => {
    it('aggregates its own metrics with a peer from the store', async () => {
        const store = fakeStore();
        // Seed a peer directly.
        await persistSnapshot(store, 'peer', snap({ rps: 100, totalRequests: 999, statusCodes: { '200': 999 } }), 120);

        const monitor = createEdgeMonitor({ store, instanceId: 'me', storeWriteInterval: 0 });
        monitor.trackRequest('/local', 'GET');
        monitor.trackRequestComplete('/local', 'GET', 5, 200);

        const merged = await monitor.getMetricsSnapshot();
        expect(merged.instanceCount).toBe(2);
        expect(merged.totalRequests).toBeGreaterThanOrEqual(1000);
    });

    it('behaves normally (local only) without a store', async () => {
        const monitor = createEdgeMonitor({});
        monitor.trackRequest('/local', 'GET');
        monitor.trackRequestComplete('/local', 'GET', 5, 200);
        const snapshot = await monitor.getMetricsSnapshot();
        expect(snapshot.totalRequests).toBe(1);
        expect(snapshot.instanceCount).toBeUndefined();
    });
});

describe('inline charts', () => {
    it('omits CDN scripts and includes the inline renderer', async () => {
        const { generateEdgeDashboard } = await import('../src/dashboard-edge');
        const html = generateEdgeDashboard({ hostname: 'h', uptime: '1s', title: 't', inlineCharts: true });
        expect(html).not.toContain('cdn.jsdelivr.net');
        expect(html).toContain('function drawSpark(');
        expect(html).toContain('var INLINE = true');
    });

    it('uses CDN by default', async () => {
        const { generateDashboard } = await import('../src/dashboard');
        const html = generateDashboard({ hostname: 'h', uptime: '1s', title: 't', socketPath: '/x' });
        expect(html).toContain('cdn.jsdelivr.net');
        expect(html).toContain('var INLINE = false');
    });
});
