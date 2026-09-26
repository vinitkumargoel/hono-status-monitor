import { describe, it, expect, vi, afterEach } from 'vitest';
import { createClusterAggregator, getWorkerId, isClusterWorker, sendMetricsToMaster } from '../src/cluster';
import type { ChartData, MetricsSnapshot, WorkerMetricsMessage } from '../src/types';

const emptyCharts = (): ChartData => ({
    cpu: [], memory: [], heap: [], loadAvg: [], responseTime: [], rps: [], eventLoopLag: [], errorRate: []
});

function msg(workerId: number, metrics: Partial<MetricsSnapshot>, charts: ChartData = emptyCharts()): WorkerMetricsMessage {
    return { type: 'worker-metrics', workerId, pid: 1000 + workerId, metrics, charts };
}

const route = (path: string, count: number, totalTime: number, errors = 0) => ({
    path, method: 'GET', count, totalTime, avgTime: totalTime / count, minTime: 1, maxTime: 9, errors, lastAccess: 1
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('cluster aggregation', () => {
    it('sums counts, averages rates and merges routes and status codes', () => {
        const agg = createClusterAggregator({ maxRoutes: 5 });
        agg.updateWorkerMetrics(msg(1, {
            rps: 2, totalRequests: 10, activeConnections: 1, cpu: 10, responseTime: 20, errorRate: 10,
            statusCodes: { '200': 9, '500': 1 }, rateLimitStats: { blocked: 1, total: 3 },
            topRoutes: [route('/a', 4, 40, 1)], slowestRoutes: [route('/a', 4, 40, 1)], errorRoutes: []
        }));
        agg.updateWorkerMetrics(msg(2, {
            rps: 3, totalRequests: 20, activeConnections: 2, cpu: 30, responseTime: 40, errorRate: 0,
            statusCodes: { '200': 20 }, rateLimitStats: { blocked: 0, total: 1 },
            topRoutes: [route('/a', 6, 120), route('/b', 1, 5)]
        }));

        const out = agg.aggregateMetrics({ statusCodes: {}, cpu: 0, responseTime: 0, errorRate: 0 } as MetricsSnapshot);
        expect(out).toMatchObject({
            rps: 5, totalRequests: 30, activeConnections: 3, cpu: 20, responseTime: 30, errorRate: 5,
            statusCodes: { '200': 29, '500': 1 }, rateLimitStats: { blocked: 1, total: 4 }, workerCount: 2
        });
        // /a counted once per worker even though worker 1 listed it twice.
        const a = out.topRoutes.find((r) => r.path === '/a')!;
        expect(a.count).toBe(10);
        expect(a.avgTime).toBe(16);
        expect(a.errors).toBe(1);
        expect(out.errorRoutes.map((r) => r.path)).toEqual(['/a']);
        expect(out.workers).toHaveLength(2);
    });

    it('merges chart series by timestamp, summing rps and averaging the rest', () => {
        const agg = createClusterAggregator();
        const charts = (rps: number, cpu: number): ChartData => ({
            ...emptyCharts(), rps: [{ timestamp: 1, value: rps }], cpu: [{ timestamp: 1, value: cpu }]
        });
        agg.updateWorkerMetrics(msg(1, {}, charts(2, 10)));
        agg.updateWorkerMetrics(msg(2, {}, charts(3, 30)));
        const merged = agg.aggregateCharts(charts(1, 20));
        expect(merged.rps).toEqual([{ timestamp: 1, value: 6 }]);
        expect(merged.cpu).toEqual([{ timestamp: 1, value: 20 }]);
    });

    it('returns the base untouched when no workers reported, and drops stale workers', () => {
        vi.useFakeTimers();
        const agg = createClusterAggregator();
        const base = { rps: 7 } as MetricsSnapshot;
        expect(agg.aggregateMetrics(base)).toBe(base);
        expect(agg.aggregateCharts(emptyCharts())).toEqual(emptyCharts());

        agg.updateWorkerMetrics(msg(1, { rps: 1 }));
        expect(agg.workerCount).toBe(1);
        vi.advanceTimersByTime(10_001);
        expect(agg.workerCount).toBe(0);
    });

    it('appends delta chart messages to what a worker sent before, trimmed to retention', () => {
        const agg = createClusterAggregator({ retentionSeconds: 2 });
        const series = (...ts: number[]) => ({ ...emptyCharts(), rps: ts.map((t) => ({ timestamp: t, value: 1 })) });
        agg.updateWorkerMetrics(msg(1, {}, series(1000, 2000)));
        agg.updateWorkerMetrics({ ...msg(1, {}, series(2000, 3000)), delta: true });
        agg.updateWorkerMetrics({ ...msg(1, {}, series(4000)), delta: true });
        const merged = agg.aggregateCharts(emptyCharts());
        expect(merged.rps.map((p) => p.timestamp)).toEqual([2000, 3000, 4000]);
    });

    it('only reports peers as delta-capable when every live peer advertised it', () => {
        const agg = createClusterAggregator();
        expect(agg.peersAcceptDeltas(1)).toBe(true);
        agg.updateWorkerMetrics({ ...msg(1, {}, emptyCharts()), deltaCapable: true });
        agg.updateWorkerMetrics({ ...msg(2, {}, emptyCharts()), deltaCapable: true });
        expect(agg.peersAcceptDeltas(1)).toBe(true);
        // A 1.1.x worker (no flag) joins during a rolling restart.
        agg.updateWorkerMetrics(msg(3, {}, emptyCharts()));
        expect(agg.peersAcceptDeltas(1)).toBe(false);
        // Our own record never blocks us.
        expect(createClusterAggregator().peersAcceptDeltas(1)).toBe(true);
    });

    it('asks for one full send when a peer appears or restarts', () => {
        const agg = createClusterAggregator();
        agg.updateWorkerMetrics(msg(2, {}));
        expect(agg.takePeerJoined()).toBe(true);
        expect(agg.takePeerJoined()).toBe(false);
        agg.updateWorkerMetrics(msg(2, {}));
        expect(agg.takePeerJoined()).toBe(false);
        agg.updateWorkerMetrics({ ...msg(2, {}), pid: 4242 });
        expect(agg.takePeerJoined()).toBe(true);
    });

    it('treats a delta from a restarted worker (new pid) as a fresh series', () => {
        const agg = createClusterAggregator();
        const series = (t: number) => ({ ...emptyCharts(), rps: [{ timestamp: t, value: 1 }] });
        agg.updateWorkerMetrics(msg(1, {}, series(1000)));
        agg.updateWorkerMetrics({ ...msg(1, {}, series(5000)), pid: 9999, delta: true });
        expect(agg.aggregateCharts(emptyCharts()).rps.map((p) => p.timestamp)).toEqual([5000]);
    });

    it('ignores malformed messages', () => {
        const agg = createClusterAggregator();
        agg.updateWorkerMetrics({ ...msg(1, {}), metrics: { rps: 'x' } } as unknown as WorkerMetricsMessage);
        expect(agg.workerCount).toBe(0);
    });
});

describe('cluster process helpers', () => {
    it('reads the PM2 instance id', () => {
        vi.stubEnv('NODE_APP_INSTANCE', '3');
        expect(isClusterWorker()).toBe(true);
        expect(getWorkerId()).toBe(3);
    });

    // Vitest may itself run inside a forked worker with a live IPC channel, so
    // swap process.send for the duration of each test.
    function withSend(send: unknown, fn: () => void) {
        const original = process.send;
        process.send = send as typeof process.send;
        try { fn(); } finally { process.send = original; }
    }

    it('is a no-op to send without an IPC channel', () => {
        withSend(undefined, () => {
            expect(() => sendMetricsToMaster({}, emptyCharts())).not.toThrow();
        });
    });

    it('sends a well-formed message when an IPC channel exists', () => {
        const send = vi.fn();
        withSend(send, () => sendMetricsToMaster({ rps: 1 }, emptyCharts()));
        expect(send.mock.calls[0][0]).toMatchObject({ type: 'worker-metrics', pid: process.pid, metrics: { rps: 1 }, deltaCapable: true });
    });
});

describe('cluster monitor wiring', () => {
    it('receives peer metrics after start() without initSocket(), and stops listening on stop()', async () => {
        const { createMonitor } = await import('../src/monitor');
        const before = process.listenerCount('message');
        const monitor = createMonitor({ clusterMode: true, logger: false });
        monitor.start();
        expect(process.listenerCount('message')).toBe(before + 1);
        monitor.initSocket(); // idempotent: no second listener
        expect(process.listenerCount('message')).toBe(before + 1);

        process.emit('message' as never, { ...msg(7, { totalRequests: 5 }), deltaCapable: true } as never);
        const snapshot = await monitor.getMetricsSnapshot();
        expect(snapshot.workers?.map((w) => w.pid)).toContain(1007);

        monitor.stop();
        expect(process.listenerCount('message')).toBe(before);
    });
});
