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
    PercentileData,
    AlertStatus,
    MetricsSnapshot,
    ChartData
} from './types.js';

// Default configuration for edge environments
const DEFAULT_EDGE_CONFIG: Required<StatusMonitorConfig> = {
    path: '/status',
    title: 'Server Status',
    socketPath: '/status/socket.io', // Not used in edge, included for compatibility
    updateInterval: 5000, // Polling interval (not real-time)
    retentionSeconds: 60,
    maxRecentErrors: 10,
    maxRoutes: 10,
    alerts: {
        cpu: 80, // Not available in edge
        memory: 90, // Not available in edge
        responseTime: 500,
        errorRate: 5,
        eventLoopLag: 100 // Not available in edge
    },
    healthCheck: async () => ({ connected: true, latencyMs: 0 }),
    normalizePath: (path: string) => path,
    clusterMode: false // Not supported in edge
};

/**
 * Default path normalization function
 */
function defaultNormalizePath(path: string): string {
    return path
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':uuid')
        .replace(/[0-9a-f]{24}/gi, ':id')
        .replace(/\/\d+/g, '/:id')
        .split('/').slice(0, 4).join('/');
}

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

    // Start time for uptime calculation
    const startTime = Date.now();

    /**
     * Calculate percentiles from samples
     */
    function calculatePercentiles(): PercentileData {
        if (responseTimeSamples.length === 0) {
            return { p50: 0, p95: 0, p99: 0, avg: 0 };
        }

        const sorted = [...responseTimeSamples].sort((a, b) => a - b);
        const len = sorted.length;

        const p50Index = Math.floor(len * 0.5);
        const p95Index = Math.floor(len * 0.95);
        const p99Index = Math.floor(len * 0.99);

        const avg = sorted.reduce((a, b) => a + b, 0) / len;

        return {
            p50: Math.round(sorted[p50Index] * 100) / 100,
            p95: Math.round(sorted[p95Index] * 100) / 100,
            p99: Math.round(sorted[Math.min(p99Index, len - 1)] * 100) / 100,
            avg: Math.round(avg * 100) / 100
        };
    }

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
        return Math.round((totalErrors / totalRequests) * 10000) / 100;
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
            const currentRps = Math.round((requestCount - lastRequestCount) / intervalSeconds);
            lastRequestCount = requestCount;
            lastUpdateTime = now;

            addToHistory(rpsHistory, currentRps);

            const avgResponseTime = responseTimeCount > 0
                ? Math.round((totalResponseTime / responseTimeCount) * 100) / 100
                : 0;
            addToHistory(responseTimeHistory, avgResponseTime);
            addToHistory(errorRateHistory, getErrorRate());

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
     * Get current metrics snapshot
     */
    async function getMetricsSnapshot(): Promise<MetricsSnapshot> {
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
            percentiles: calculatePercentiles(),
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
     * Get chart data
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

    /**
     * Format uptime
     */
    function formatUptime(seconds: number): string {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        const parts: string[] = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        parts.push(`${secs}s`);

        return parts.join(' ');
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
        start,
        stop,
        initSocket,
        formatUptime,
        isEdgeMode: true,
        get io() { return null; }
    };
}

export type EdgeMonitor = ReturnType<typeof createEdgeMonitor>;
