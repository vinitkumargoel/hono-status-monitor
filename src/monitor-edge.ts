// =============================================================================
// HONO STATUS MONITOR - EDGE-COMPATIBLE MONITOR
// Lightweight monitor for Cloudflare Workers and Edge environments
// No Node.js-specific APIs (os, process, cluster, socket.io)
// =============================================================================

import type {
    StatusMonitorConfig,
    MetricDataPoint,
    StatusCodeCount,
    RouteStats,
    ErrorEntry,
    AlertStatus,
    AlertEvent,
    HealthCheckResult,
    MetricsSnapshot,
    ChartData,
    NamedHealthResult,
    HealthReport,
    StatusStore
} from './types.js';
import { calculatePercentiles, defaultNormalizePath, formatUptime, round } from './metrics-utils.js';
import { persistSnapshot, loadPeerSnapshots, mergeSnapshots, generateInstanceId } from './edge-store.js';

// Default configuration for edge environments
const DEFAULT_EDGE_CONFIG: Required<StatusMonitorConfig> = {
    path: '/status',
    title: 'Server Status',
    socketPath: '/status/socket.io', // Not used in edge, included for compatibility
    pollingInterval: 5000, // Dashboard polling interval (5s for edge)
    updateInterval: 5000, // Polling interval (not real-time)
    retentionSeconds: 60,
    maxRecentErrors: 10,
    maxRoutes: 10,
    maxTrackedRoutes: 1000,
    alerts: {
        cpu: 80, // Not available in edge
        memory: 90, // Not available in edge
        responseTime: 500,
        errorRate: 5,
        eventLoopLag: 100 // Not available in edge
    },
    healthCheck: async () => ({ connected: true, latencyMs: 0 }),
    healthChecks: undefined as unknown as Record<string, () => Promise<HealthCheckResult>>,
    normalizePath: (path: string) => path,
    clusterMode: false, // Not supported in edge
    authorize: undefined as unknown as (c: any) => boolean | Promise<boolean>,
    onAlert: undefined as unknown as (event: AlertEvent) => void,
    prometheus: true,
    prometheusPrefix: 'hono',
    chartjsUrl: undefined as unknown as string,
    chartAdapterUrl: undefined as unknown as string,
    inlineCharts: false,
    store: undefined as unknown as StatusStore,
    instanceId: undefined as unknown as string,
    storeWriteInterval: 60000
};

/**
 * Create an edge-compatible status monitor instance
 * Works without Node.js APIs (os, process, cluster)
 */
export function createEdgeMonitor(userConfig: StatusMonitorConfig = {}) {
    // Merge configuration
    const config: Required<StatusMonitorConfig> = {
        ...DEFAULT_EDGE_CONFIG,
        ...userConfig,
        alerts: { ...DEFAULT_EDGE_CONFIG.alerts, ...userConfig.alerts },
        normalizePath: userConfig.normalizePath || defaultNormalizePath,
        clusterMode: false // Never in cluster mode on edge
    };

    // In-memory metrics storage
    let responseTimeHistory: MetricDataPoint[] = [];
    let rpsHistory: MetricDataPoint[] = [];
    let errorRateHistory: MetricDataPoint[] = [];

    // Request tracking
    let requestCount = 0;
    let lastRequestCount = 0;
    let lastUpdateTime = Date.now();
    let totalResponseTime = 0;
    let responseTimeCount = 0;
    let statusCodes: StatusCodeCount = {};
    let totalRequests = 0;
    let activeConnections = 0;

    // Route tracking
    const routeStats: Map<string, RouteStats> = new Map();
    const recentErrors: ErrorEntry[] = [];

    // Response time samples for percentiles
    let responseTimeSamples: number[] = [];

    // Rate limit tracking
    let rateLimitBlocked = 0;
    let rateLimitTotal = 0;

    // Alert transition state (for onAlert callbacks)
    let lastAlertState: AlertStatus = {
        cpu: false, memory: false, responseTime: false, errorRate: false, eventLoopLag: false
    };

    // Cross-isolate store state (opt-in via config.store)
    const instanceId = config.instanceId || generateInstanceId();
    let lastPersistTime = 0;

    // Start time for uptime calculation
    const startTime = Date.now();

    /**
     * Get top routes by request count
     */
    function getTopRoutes(): RouteStats[] {
        return Array.from(routeStats.values())
            .sort((a, b) => b.count - a.count)
            .slice(0, config.maxRoutes);
    }

    /**
     * Get slowest routes by average response time
     */
    function getSlowestRoutes(): RouteStats[] {
        return Array.from(routeStats.values())
            .filter(r => r.count > 0)
            .sort((a, b) => b.avgTime - a.avgTime)
            .slice(0, config.maxRoutes);
    }

    /**
     * Get routes with most errors
     */
    function getErrorRoutes(): RouteStats[] {
        return Array.from(routeStats.values())
            .filter(r => r.errors > 0)
            .sort((a, b) => b.errors - a.errors)
            .slice(0, config.maxRoutes);
    }

    /**
     * Calculate current error rate
     */
    function getErrorRate(): number {
        const totalErrors = Array.from(routeStats.values()).reduce((sum, r) => sum + r.errors, 0);
        if (totalRequests === 0) return 0;
        return round((totalErrors / totalRequests) * 100);
    }

    /**
     * Check alert conditions (limited to available metrics)
     */
    function checkAlerts(): AlertStatus {
        const respTime = responseTimeHistory.length > 0
            ? responseTimeHistory[responseTimeHistory.length - 1].value
            : 0;
        const errorRate = getErrorRate();

        return {
            cpu: false, // Not available in edge
            memory: false, // Not available in edge
            responseTime: respTime > (config.alerts.responseTime ?? 500),
            errorRate: errorRate > (config.alerts.errorRate ?? 5),
            eventLoopLag: false // Not available in edge
        };
    }

    // Fire onAlert only on OK<->breached transitions.
    function fireAlertTransitions(): void {
        if (!config.onAlert) return;
        const current = checkAlerts();
        const respTime = responseTimeHistory.length > 0 ? responseTimeHistory[responseTimeHistory.length - 1].value : 0;
        const values: Record<keyof AlertStatus, number> = {
            cpu: 0, memory: 0, eventLoopLag: 0,
            responseTime: respTime,
            errorRate: getErrorRate()
        };
        const thresholds: Record<keyof AlertStatus, number> = {
            cpu: config.alerts.cpu ?? 80,
            memory: config.alerts.memory ?? 90,
            responseTime: config.alerts.responseTime ?? 500,
            errorRate: config.alerts.errorRate ?? 5,
            eventLoopLag: config.alerts.eventLoopLag ?? 100
        };
        (Object.keys(current) as (keyof AlertStatus)[]).forEach((metric) => {
            if (current[metric] !== lastAlertState[metric]) {
                try {
                    config.onAlert!({
                        metric, active: current[metric],
                        value: values[metric], threshold: thresholds[metric],
                        timestamp: Date.now()
                    });
                } catch { /* ignore user callback errors */ }
            }
        });
        lastAlertState = current;
    }

    // Cap distinct tracked routes; evict least-recently-accessed.
    function evictRoutesIfNeeded(): void {
        if (routeStats.size < config.maxTrackedRoutes) return;
        let oldestKey: string | null = null;
        let oldestAccess = Infinity;
        for (const [k, v] of routeStats) {
            if (v.lastAccess < oldestAccess) {
                oldestAccess = v.lastAccess;
                oldestKey = k;
            }
        }
        if (oldestKey) routeStats.delete(oldestKey);
    }

    // Run configured named health checks (falls back to the single healthCheck).
    async function getHealthReport(): Promise<HealthReport> {
        const checks = config.healthChecks
            ? Object.entries(config.healthChecks)
            : ([['database', config.healthCheck]] as [string, () => Promise<HealthCheckResult>][]);
        const results: NamedHealthResult[] = await Promise.all(
            checks.map(async ([name, fn]) => {
                try {
                    const start = Date.now();
                    const r = await fn();
                    return { name: r.name || name, connected: r.connected, latencyMs: r.latencyMs || (Date.now() - start), details: r.details };
                } catch (err) {
                    return { name, connected: false, latencyMs: 0, details: { error: err instanceof Error ? err.message : String(err) } };
                }
            })
        );
        return {
            status: results.every(r => r.connected) ? 'ok' : 'degraded',
            uptime: Math.round((Date.now() - startTime) / 1000),
            timestamp: Date.now(),
            checks: results
        };
    }

    // Clear accumulated request/route/error counters.
    function resetStats(): void {
        responseTimeHistory = [];
        rpsHistory = [];
        errorRateHistory = [];
        requestCount = 0;
        lastRequestCount = 0;
        totalResponseTime = 0;
        responseTimeCount = 0;
        statusCodes = {};
        totalRequests = 0;
        activeConnections = 0;
        routeStats.clear();
        recentErrors.length = 0;
        responseTimeSamples = [];
        rateLimitBlocked = 0;
        rateLimitTotal = 0;
    }

    /**
     * Add a data point to history
     */
    function addToHistory(history: MetricDataPoint[], value: number): void {
        const now = Date.now();
        history.push({ timestamp: now, value });

        const cutoff = now - (config.retentionSeconds * 1000);
        while (history.length > 0 && history[0].timestamp < cutoff) {
            history.shift();
        }
    }

    /**
     * Update metrics (called on each request in edge mode, not on interval)
     */
    function updateMetricsIfNeeded(): void {
        const now = Date.now();
        const elapsed = now - lastUpdateTime;

        // Only update history at configured intervals
        if (elapsed >= config.updateInterval) {
            const intervalSeconds = elapsed / 1000;
            const currentRps = round((requestCount - lastRequestCount) / intervalSeconds);
            lastRequestCount = requestCount;
            lastUpdateTime = now;

            addToHistory(rpsHistory, currentRps);

            const avgResponseTime = responseTimeCount > 0
                ? round(totalResponseTime / responseTimeCount)
                : 0;
            addToHistory(responseTimeHistory, avgResponseTime);
            addToHistory(errorRateHistory, getErrorRate());

            fireAlertTransitions();

            // Reset counters
            totalResponseTime = 0;
            responseTimeCount = 0;

            // Trim samples (keep last 1000)
            if (responseTimeSamples.length > 1000) {
                responseTimeSamples = responseTimeSamples.slice(-500);
            }
        }
    }

    /**
     * Track a request start
     */
    function trackRequest(path: string, method: string): void {
        requestCount++;
        totalRequests++;
        activeConnections++;

        const normalizedPath = config.normalizePath(path);
        const key = `${method}:${normalizedPath}`;

        if (!routeStats.has(key)) {
            evictRoutesIfNeeded();
            routeStats.set(key, {
                path: normalizedPath,
                method,
                count: 0,
                totalTime: 0,
                avgTime: 0,
                minTime: Infinity,
                maxTime: 0,
                errors: 0,
                lastAccess: Date.now()
            });
        }
    }

    /**
     * Track request completion
     */
    function trackRequestComplete(
        path: string,
        method: string,
        durationMs: number,
        statusCode: number
    ): void {
        activeConnections = Math.max(0, activeConnections - 1);

        // Track response time
        totalResponseTime += durationMs;
        responseTimeCount++;
        responseTimeSamples.push(durationMs);

        // Track status code
        const codeStr = statusCode.toString();
        statusCodes[codeStr] = (statusCodes[codeStr] || 0) + 1;

        // Update route stats
        const normalizedPath = config.normalizePath(path);
        const key = `${method}:${normalizedPath}`;
        const stats = routeStats.get(key);

        if (stats) {
            stats.count++;
            stats.totalTime += durationMs;
            stats.avgTime = stats.totalTime / stats.count;
            stats.minTime = Math.min(stats.minTime, durationMs);
            stats.maxTime = Math.max(stats.maxTime, durationMs);
            stats.lastAccess = Date.now();

            // Track errors
            if (statusCode >= 400) {
                stats.errors++;

                recentErrors.unshift({
                    timestamp: Date.now(),
                    path: normalizedPath,
                    method,
                    status: statusCode,
                    message: `${method} ${normalizedPath} returned ${statusCode}`
                });

                while (recentErrors.length > config.maxRecentErrors) {
                    recentErrors.pop();
                }
            }
        }

        // Update metrics if interval has passed
        updateMetricsIfNeeded();
    }

    /**
     * Track rate limit event
     */
    function trackRateLimitEvent(blocked: boolean): void {
        rateLimitTotal++;
        if (blocked) rateLimitBlocked++;
    }

    /**
     * Build this isolate's own metrics snapshot (no cross-isolate aggregation).
     */
    async function getLocalSnapshot(): Promise<MetricsSnapshot> {
        // Trigger update check
        updateMetricsIfNeeded();

        const uptimeSeconds = Math.round((Date.now() - startTime) / 1000);

        return {
            timestamp: Date.now(),
            // System metrics - not available in edge
            cpu: 0,
            memoryMB: 0,
            memoryPercent: 0,
            heapUsedMB: 0,
            heapTotalMB: 0,
            loadAvg: 0,
            uptime: uptimeSeconds, // Worker uptime
            processUptime: uptimeSeconds,
            // Request metrics - available
            responseTime: responseTimeHistory.length > 0
                ? responseTimeHistory[responseTimeHistory.length - 1].value
                : 0,
            rps: rpsHistory.length > 0
                ? rpsHistory[rpsHistory.length - 1].value
                : 0,
            statusCodes: { ...statusCodes },
            totalRequests,
            activeConnections,
            eventLoopLag: 0, // Not available in edge
            // Platform info
            hostname: 'cloudflare-worker',
            platform: 'Cloudflare Workers',
            nodeVersion: 'N/A',
            pid: 0,
            cpuCount: 0,
            // Analytics - available
            percentiles: calculatePercentiles(responseTimeSamples),
            topRoutes: getTopRoutes(),
            slowestRoutes: getSlowestRoutes(),
            errorRoutes: getErrorRoutes(),
            recentErrors: [...recentErrors],
            alerts: checkAlerts(),
            // Not available metrics
            gc: {
                collections: 0,
                pauseTimeMs: 0,
                heapGrowthRate: 0
            },
            database: {
                connected: false,
                poolSize: 0,
                availableConnections: 0,
                waitQueueSize: 0,
                latencyMs: 0
            },
            rateLimitStats: { blocked: rateLimitBlocked, total: rateLimitTotal },
            errorRate: getErrorRate(),
            // Edge mode indicator
            isEdgeMode: true
        };
    }

    /**
     * Persist this isolate's snapshot to the store (rate-limited, best-effort).
     */
    async function maybePersist(snapshot: MetricsSnapshot): Promise<void> {
        if (!config.store) return;
        const now = Date.now();
        if (now - lastPersistTime < config.storeWriteInterval) return;
        lastPersistTime = now;
        const ttlSeconds = Math.max(config.retentionSeconds, (config.storeWriteInterval / 1000) * 3);
        await persistSnapshot(config.store, instanceId, snapshot, ttlSeconds);
    }

    /**
     * Get current metrics snapshot. When a `store` is configured, this returns an
     * approximate fleet-wide aggregate across isolates; otherwise it is local.
     */
    async function getMetricsSnapshot(): Promise<MetricsSnapshot> {
        const local = await getLocalSnapshot();
        if (!config.store) return local;

        // Best-effort persist + peer merge; never let store failures break the read.
        try {
            await maybePersist(local);
            const peers = await loadPeerSnapshots(config.store, instanceId);
            return mergeSnapshots(local, peers, {
                maxRoutes: config.maxRoutes,
                maxRecentErrors: config.maxRecentErrors
            });
        } catch {
            return local;
        }
    }

    /**
     * Get chart data.
     *
     * NOTE: chart histories are always LOCAL to this isolate, even when a `store`
     * is configured and `getMetricsSnapshot()` returns fleet-aggregated numbers.
     * Per-isolate time-series can't be summed across isolates without shared
     * timestamp buckets, so the dashboard's numeric cards show the fleet total
     * while the sparklines show this isolate's own trend.
     */
    function getChartData(): ChartData {
        return {
            cpu: [], // Not available
            memory: [], // Not available
            heap: [], // Not available
            loadAvg: [], // Not available
            responseTime: [...responseTimeHistory],
            rps: [...rpsHistory],
            eventLoopLag: [], // Not available
            errorRate: [...errorRateHistory]
        };
    }

    // No-op functions for compatibility
    function start(): void {
        // No interval needed in edge - updates happen on each request
        console.log('📊 Status monitor started (edge mode)');
    }

    function stop(): void {
        // Nothing to stop in edge mode
        console.log('📊 Status monitor stopped (edge mode)');
    }

    // Socket not available in edge
    function initSocket(): null {
        console.log('📊 WebSocket not available in edge mode, use polling');
        return null;
    }

    return {
        config,
        trackRequest,
        trackRequestComplete,
        trackRateLimitEvent,
        getMetricsSnapshot,
        getChartData,
        getHealthReport,
        resetStats,
        start,
        stop,
        initSocket,
        formatUptime,
        isEdgeMode: true,
        get io() { return null; }
    };
}

export type EdgeMonitor = ReturnType<typeof createEdgeMonitor>;
