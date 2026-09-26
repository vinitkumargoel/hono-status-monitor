// =============================================================================
// HONO STATUS MONITOR - CLUSTER UTILITIES
// PM2 / Node.js Cluster mode support for metrics aggregation
// =============================================================================

import cluster from 'node:cluster';
import type {
    MetricsSnapshot,
    ChartData,
    WorkerInfo,
    WorkerMetricsMessage,
    MetricDataPoint,
    RouteStats,
    StatusCodeCount
} from './types.js';
import { round } from './metrics-utils.js';

/**
 * Check if running in cluster mode (PM2 or native Node.js cluster)
 */
export function isClusterWorker(): boolean {
    // NOTE: PM2_HOME alone is not used — it is present for the whole shell whenever
    // PM2 is installed and would wrongly flag a plain `node app.js` as a cluster worker.
    // NODE_APP_INSTANCE is set per PM2 instance and is the reliable signal.
    return cluster.isWorker || !!process.env.NODE_APP_INSTANCE;
}

/**
 * Check if this is the primary/master process
 */
export function isClusterMaster(): boolean {
    return cluster.isPrimary || cluster.isMaster;
}

/**
 * Get worker ID
 */
export function getWorkerId(): number {
    if (cluster.worker) {
        return cluster.worker.id;
    }
    // PM2 instance ID
    const instanceId = process.env.NODE_APP_INSTANCE;
    if (instanceId) {
        return parseInt(instanceId, 10);
    }
    return 0;
}

/**
 * Send metrics from worker to parent process (for PM2 cluster mode)
 */
export function sendMetricsToMaster(
    metrics: Partial<MetricsSnapshot>,
    charts: ChartData,
    delta = false
): void {
    if (!process.send) return;

    const message: WorkerMetricsMessage = {
        type: 'worker-metrics',
        workerId: getWorkerId(),
        pid: process.pid,
        metrics,
        charts,
        deltaCapable: true,
        ...(delta ? { delta: true } : {})
    };

    try {
        process.send(message);
    } catch {
        // Silently ignore send errors (master may have died)
    }
}

/** Numeric snapshot fields the aggregator sums or averages. */
const NUMERIC_METRIC_FIELDS = [
    'cpu', 'memoryMB', 'rps', 'totalRequests', 'activeConnections', 'responseTime', 'errorRate'
] as const;

/** Upper bound on points per chart series accepted over IPC. */
const MAX_IPC_CHART_POINTS = 10000;

function isFiniteNumber(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v);
}

function isPointArray(v: unknown): boolean {
    return Array.isArray(v) &&
        v.length <= MAX_IPC_CHART_POINTS &&
        v.every((p) => p && typeof p === 'object' &&
            isFiniteNumber((p as MetricDataPoint).timestamp) &&
            isFiniteNumber((p as MetricDataPoint).value));
}

/**
 * Shape-check an IPC message before it is merged into the aggregate. IPC is
 * only reachable from processes the app itself forked, so this is defence in
 * depth: it stops a malformed message (a version skew during a rolling restart,
 * another library sharing the channel) from turning sums into NaN or string
 * concatenation.
 */
export function isWorkerMetricsMessage(message: unknown): message is WorkerMetricsMessage {
    if (!message || typeof message !== 'object') return false;
    const m = message as Partial<WorkerMetricsMessage>;
    if (m.type !== 'worker-metrics') return false;
    if (!isFiniteNumber(m.workerId) || !isFiniteNumber(m.pid)) return false;
    if (!m.metrics || typeof m.metrics !== 'object') return false;
    for (const key of NUMERIC_METRIC_FIELDS) {
        const v = (m.metrics as Record<string, unknown>)[key];
        if (v !== undefined && !isFiniteNumber(v)) return false;
    }
    if (!m.charts || typeof m.charts !== 'object') return false;
    for (const series of Object.values(m.charts)) {
        if (!isPointArray(series)) return false;
    }
    return true;
}

/**
 * Worker metrics store for aggregation in master
 */
interface WorkerMetricsStore {
    [workerId: number]: {
        pid: number;
        metrics: Partial<MetricsSnapshot>;
        charts: ChartData;
        lastUpdate: number;
        deltaCapable: boolean;
    };
}

/**
 * Create a cluster aggregator for the master process
 */
export function createClusterAggregator(options: { maxRoutes?: number; retentionSeconds?: number } = {}) {
    const workerMetrics: WorkerMetricsStore = {};
    const WORKER_TIMEOUT_MS = 10000; // Consider worker dead after 10s no update
    // Match the single-instance route-list cap (config.maxRoutes) so aggregated
    // views aren't silently truncated shorter than a per-worker view.
    const maxRoutes = options.maxRoutes ?? 10;

    /**
     * Update metrics from a worker
     */
    const retentionMs = (options.retentionSeconds ?? 60) * 1000;

    /** Append delta points to a stored series and trim it to the retention window. */
    function appendSeries(stored: MetricDataPoint[] | undefined, fresh: MetricDataPoint[]): MetricDataPoint[] {
        const base = stored ?? [];
        const lastTs = base.at(-1)?.timestamp ?? -Infinity;
        const merged = base.concat(fresh.filter((p) => p.timestamp > lastTs));
        const newest = merged.at(-1)?.timestamp ?? 0;
        const cutoff = newest - retentionMs;
        let start = 0;
        while (start < merged.length && (merged[start]?.timestamp ?? Infinity) < cutoff) start++;
        return start ? merged.slice(start) : merged;
    }

    function updateWorkerMetrics(message: WorkerMetricsMessage): void {
        if (!isWorkerMetricsMessage(message)) return;
        const previous = workerMetrics[message.workerId];
        // A peer we have no state for (new, restarted, or evicted after a
        // pause) has no charts of ours either: send it a full payload next.
        if (!previous || previous.pid !== message.pid) peerJoined = true;
        let charts = message.charts;
        if (message.delta && previous && previous.pid === message.pid) {
            charts = { ...previous.charts };
            for (const key of Object.keys(message.charts) as (keyof ChartData)[]) {
                charts[key] = appendSeries(previous.charts[key], message.charts[key]);
            }
        }
        workerMetrics[message.workerId] = {
            pid: message.pid,
            metrics: message.metrics,
            charts,
            lastUpdate: Date.now(),
            deltaCapable: message.deltaCapable === true
        };
    }

    /**
     * True when every live peer other than `selfId` understands delta charts.
     * A 1.1.x peer replaces its stored charts with whatever arrives, so it must
     * keep getting full payloads.
     */
    let peerJoined = false;
    /** True once after a new peer appears; the next send should be full. */
    function takePeerJoined(): boolean {
        const joined = peerJoined;
        peerJoined = false;
        return joined;
    }

    function peersAcceptDeltas(selfId: number): boolean {
        cleanupStaleWorkers();
        for (const [id, w] of Object.entries(workerMetrics)) {
            if (Number(id) !== selfId && !w.deltaCapable) return false;
        }
        return true;
    }

    /**
     * Clean up stale workers
     */
    function cleanupStaleWorkers(): void {
        const now = Date.now();
        for (const [workerId, worker] of Object.entries(workerMetrics)) {
            if (now - worker.lastUpdate > WORKER_TIMEOUT_MS) {
                delete workerMetrics[Number(workerId)];
            }
        }
    }

    /**
     * Get all active worker info
     */
    function getWorkerInfo(): WorkerInfo[] {
        cleanupStaleWorkers();
        return Object.values(workerMetrics).map(w => ({
            pid: w.pid,
            cpu: w.metrics.cpu || 0,
            memoryMB: w.metrics.memoryMB || 0,
            rps: w.metrics.rps || 0,
            totalRequests: w.metrics.totalRequests || 0,
            responseTime: w.metrics.responseTime || 0
        }));
    }

    /**
     * Aggregate metrics from all workers
     */
    function aggregateMetrics(baseSnapshot: MetricsSnapshot): MetricsSnapshot {
        cleanupStaleWorkers();

        const workers = Object.values(workerMetrics);
        if (workers.length === 0) {
            return baseSnapshot;
        }

        // Sum metrics that should be totaled across workers
        let totalRps = 0;
        let totalRequests = 0;
        let totalActiveConnections = 0;
        let totalErrorRate = 0;

        // Average metrics that should be averaged
        let totalCpu = 0;
        let totalResponseTime = 0;
        let workerCount = 0;

        // Aggregate status codes
        const aggregatedStatusCodes: StatusCodeCount = {};

        // Aggregate rate limit stats
        let totalRateLimitBlocked = 0;
        let totalRateLimitTotal = 0;

        // Aggregate routes
        const routeMap = new Map<string, RouteStats>();

        for (const worker of workers) {
            const m = worker.metrics;
            workerCount++;

            // Sum
            totalRps += m.rps || 0;
            totalRequests += m.totalRequests || 0;
            totalActiveConnections += m.activeConnections || 0;

            // For averaging
            totalCpu += m.cpu || 0;
            totalResponseTime += m.responseTime || 0;
            totalErrorRate += m.errorRate || 0;

            // Aggregate status codes
            if (m.statusCodes) {
                for (const [code, count] of Object.entries(m.statusCodes)) {
                    aggregatedStatusCodes[code] = (aggregatedStatusCodes[code] || 0) + (count as number);
                }
            }

            // Aggregate rate limit stats
            if (m.rateLimitStats) {
                totalRateLimitBlocked += m.rateLimitStats.blocked || 0;
                totalRateLimitTotal += m.rateLimitStats.total || 0;
            }

            // Aggregate routes. topRoutes/slowestRoutes/errorRoutes overlap heavily,
            // so dedupe by key WITHIN a worker first to avoid counting a route 2-3x.
            const perWorkerRoutes = new Map<string, RouteStats>();
            for (const route of [...(m.topRoutes || []), ...(m.slowestRoutes || []), ...(m.errorRoutes || [])]) {
                perWorkerRoutes.set(`${route.method}:${route.path}`, route);
            }

            for (const route of perWorkerRoutes.values()) {
                const key = `${route.method}:${route.path}`;
                const existing = routeMap.get(key);

                if (existing) {
                    existing.count += route.count;
                    existing.totalTime += route.totalTime;
                    existing.avgTime = existing.totalTime / existing.count;
                    existing.minTime = Math.min(existing.minTime, route.minTime);
                    existing.maxTime = Math.max(existing.maxTime, route.maxTime);
                    existing.errors += route.errors;
                    existing.lastAccess = Math.max(existing.lastAccess, route.lastAccess);
                } else {
                    routeMap.set(key, { ...route });
                }
            }
        }

        // Calculate averages
        const avgCpu = workerCount > 0 ? totalCpu / workerCount : baseSnapshot.cpu;
        const avgResponseTime = workerCount > 0 ? totalResponseTime / workerCount : baseSnapshot.responseTime;
        const avgErrorRate = workerCount > 0 ? totalErrorRate / workerCount : baseSnapshot.errorRate;

        // Get aggregated routes
        const allRoutes = Array.from(routeMap.values());
        const topRoutes = allRoutes.sort((a, b) => b.count - a.count).slice(0, maxRoutes);
        const slowestRoutes = allRoutes.filter(r => r.count > 0).sort((a, b) => b.avgTime - a.avgTime).slice(0, maxRoutes);
        const errorRoutes = allRoutes.filter(r => r.errors > 0).sort((a, b) => b.errors - a.errors).slice(0, maxRoutes);

        return {
            ...baseSnapshot,
            cpu: round(avgCpu, 1),
            responseTime: round(avgResponseTime),
            rps: totalRps,
            totalRequests,
            activeConnections: totalActiveConnections,
            errorRate: round(avgErrorRate),
            statusCodes: Object.keys(aggregatedStatusCodes).length > 0
                ? aggregatedStatusCodes
                : baseSnapshot.statusCodes,
            rateLimitStats: {
                blocked: totalRateLimitBlocked,
                total: totalRateLimitTotal
            },
            topRoutes,
            slowestRoutes,
            errorRoutes,
            workers: getWorkerInfo(),
            workerCount
        };
    }

    /**
     * Aggregate chart data from all workers
     */
    function aggregateCharts(baseCharts: ChartData): ChartData {
        cleanupStaleWorkers();

        const workers = Object.values(workerMetrics);
        if (workers.length === 0) {
            return baseCharts;
        }

        // For charts, we need to merge data points by timestamp
        const mergeChartData = (
            base: MetricDataPoint[],
            workerCharts: ChartData[],
            key: keyof ChartData,
            aggregationType: 'sum' | 'avg'
        ): MetricDataPoint[] => {
            const timeMap = new Map<number, { sum: number; count: number }>();

            // Add base data
            for (const point of base) {
                timeMap.set(point.timestamp, { sum: point.value, count: 1 });
            }

            // Add worker data
            for (const wc of workerCharts) {
                const data = wc[key] as MetricDataPoint[];
                for (const point of data) {
                    const existing = timeMap.get(point.timestamp);
                    if (existing) {
                        existing.sum += point.value;
                        existing.count++;
                    } else {
                        timeMap.set(point.timestamp, { sum: point.value, count: 1 });
                    }
                }
            }

            // Convert back to array
            const result: MetricDataPoint[] = [];
            for (const [timestamp, { sum, count }] of timeMap.entries()) {
                const value = aggregationType === 'sum' ? sum : sum / count;
                result.push({ timestamp, value: round(value) });
            }

            return result.sort((a, b) => a.timestamp - b.timestamp);
        };

        const workerCharts = workers.map(w => w.charts);

        return {
            cpu: mergeChartData(baseCharts.cpu, workerCharts, 'cpu', 'avg'),
            memory: mergeChartData(baseCharts.memory, workerCharts, 'memory', 'avg'),
            heap: mergeChartData(baseCharts.heap, workerCharts, 'heap', 'avg'),
            loadAvg: mergeChartData(baseCharts.loadAvg, workerCharts, 'loadAvg', 'avg'),
            responseTime: mergeChartData(baseCharts.responseTime, workerCharts, 'responseTime', 'avg'),
            rps: mergeChartData(baseCharts.rps, workerCharts, 'rps', 'sum'),
            eventLoopLag: mergeChartData(baseCharts.eventLoopLag, workerCharts, 'eventLoopLag', 'avg'),
            errorRate: mergeChartData(baseCharts.errorRate, workerCharts, 'errorRate', 'avg')
        };
    }

    return {
        updateWorkerMetrics,
        getWorkerInfo,
        aggregateMetrics,
        aggregateCharts,
        peersAcceptDeltas,
        takePeerJoined,
        get workerCount() {
            cleanupStaleWorkers();
            return Object.keys(workerMetrics).length;
        }
    };
}

export type ClusterAggregator = ReturnType<typeof createClusterAggregator>;

/**
 * Wire up metrics relaying in the primary/master process.
 *
 * Call this ONCE in your cluster entry file after forking workers. It listens
 * for `worker-metrics` IPC messages and broadcasts them to every worker so each
 * worker's dashboard can render the aggregated view — no Redis or external
 * store required.
 *
 * @example
 * ```typescript
 * import cluster from 'node:cluster';
 * import { setupClusterPrimary } from 'hono-status-monitor';
 *
 * if (cluster.isPrimary) {
 *     for (let i = 0; i < os.cpus().length; i++) cluster.fork();
 *     setupClusterPrimary(); // relays + auto-replaces dead workers
 * } else {
 *     await import('./server.js');
 * }
 * ```
 *
 * @param options.respawn Re-fork a worker when one exits (default: true)
 */
export function setupClusterPrimary(options: { respawn?: boolean } = {}): void {
    if (!isClusterMaster()) return;
    const { respawn = true } = options;

    const broadcast = (message: unknown) => {
        if (isWorkerMetricsMessage(message)) {
            for (const id in cluster.workers) {
                cluster.workers[id]?.send(message);
            }
        }
    };

    const attach = (worker: import('node:cluster').Worker) => worker.on('message', broadcast);

    for (const id in cluster.workers) {
        const worker = cluster.workers[id];
        if (worker) attach(worker);
    }
    cluster.on('fork', attach);

    if (respawn) {
        cluster.on('exit', () => {
            cluster.fork();
        });
    }
}
