// =============================================================================
// HONO STATUS MONITOR - CLUSTER UTILITIES
// PM2 / Node.js Cluster mode support for metrics aggregation
// =============================================================================

import cluster from 'cluster';
import type {
    MetricsSnapshot,
    ChartData,
    WorkerInfo,
    WorkerMetricsMessage,
    MetricDataPoint,
    RouteStats,
    StatusCodeCount
} from './types.js';

/**
 * Check if running in cluster mode (PM2 or native Node.js cluster)
 */
export function isClusterWorker(): boolean {
    return cluster.isWorker || !!process.env.PM2_HOME || !!process.env.NODE_APP_INSTANCE;
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
    charts: ChartData
): void {
    if (!process.send) return;

    const message: WorkerMetricsMessage = {
        type: 'worker-metrics',
        workerId: getWorkerId(),
        pid: process.pid,
        metrics,
        charts
    };

    try {
        process.send(message);
    } catch (error) {
        // Silently ignore send errors (master may have died)
    }
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
    };
}

/**
 * Create a cluster aggregator for the master process
 */
export function createClusterAggregator() {
    const workerMetrics: WorkerMetricsStore = {};
    const WORKER_TIMEOUT_MS = 10000; // Consider worker dead after 10s no update

    /**
     * Update metrics from a worker
     */
    function updateWorkerMetrics(message: WorkerMetricsMessage): void {
        workerMetrics[message.workerId] = {
            pid: message.pid,
            metrics: message.metrics,
            charts: message.charts,
            lastUpdate: Date.now()
        };
    }

    /**
     * Clean up stale workers
     */
    function cleanupStaleWorkers(): void {
        const now = Date.now();
        for (const workerId of Object.keys(workerMetrics)) {
            if (now - workerMetrics[parseInt(workerId)].lastUpdate > WORKER_TIMEOUT_MS) {
                delete workerMetrics[parseInt(workerId)];
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

            // Aggregate routes
            const allRoutes = [
                ...(m.topRoutes || []),
                ...(m.slowestRoutes || []),
                ...(m.errorRoutes || [])
            ];

            for (const route of allRoutes) {
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
        const topRoutes = allRoutes.sort((a, b) => b.count - a.count).slice(0, 10);
        const slowestRoutes = allRoutes.filter(r => r.count > 0).sort((a, b) => b.avgTime - a.avgTime).slice(0, 10);
        const errorRoutes = allRoutes.filter(r => r.errors > 0).sort((a, b) => b.errors - a.errors).slice(0, 10);

        return {
            ...baseSnapshot,
            cpu: Math.round(avgCpu * 10) / 10,
            responseTime: Math.round(avgResponseTime * 100) / 100,
            rps: totalRps,
            totalRequests,
            activeConnections: totalActiveConnections,
            errorRate: Math.round(avgErrorRate * 100) / 100,
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
                result.push({ timestamp, value: Math.round(value * 100) / 100 });
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
        get workerCount() {
            cleanupStaleWorkers();
            return Object.keys(workerMetrics).length;
        }
    };
}

export type ClusterAggregator = ReturnType<typeof createClusterAggregator>;
