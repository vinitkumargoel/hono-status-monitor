// =============================================================================
// HONO STATUS MONITOR - SHARED STATS CORE
// Platform-independent request/route/error accounting, shared by the Node and
// edge monitors. Holds the mutable counters both implementations read from.
// =============================================================================

import type {
    StatusMonitorConfig,
    MetricDataPoint,
    StatusCodeCount,
    RouteStats,
    ErrorEntry,
    HealthCheckResult,
    NamedHealthResult,
    HealthReport
} from './types.js';
import { round } from './metrics-utils.js';

/**
 * Mutable counters owned by the core. Exposed directly (rather than behind
 * accessors) because both monitors read these on every snapshot and the
 * indirection would cost more than it buys.
 */
export interface StatsState {
    requestCount: number;
    lastRequestCount: number;
    totalResponseTime: number;
    responseTimeCount: number;
    statusCodes: StatusCodeCount;
    totalRequests: number;
    activeConnections: number;
    responseTimeSamples: number[];
    rateLimitBlocked: number;
    rateLimitTotal: number;
    readonly routeStats: Map<string, RouteStats>;
    readonly recentErrors: ErrorEntry[];
}

export interface StatsCoreOptions {
    /**
     * Invoked at the end of `trackRequestComplete`. The edge monitor uses this
     * to roll its history buckets, since it has no interval timer.
     */
    onRequestComplete?: () => void;
    /** Uptime in seconds, for `getHealthReport`. Differs per platform. */
    uptimeSeconds: () => number;
}

/**
 * Create the shared accounting core for a monitor instance.
 */
export function createStatsCore(
    config: Required<StatusMonitorConfig>,
    options: StatsCoreOptions
) {
    const state: StatsState = {
        requestCount: 0,
        lastRequestCount: 0,
        totalResponseTime: 0,
        responseTimeCount: 0,
        statusCodes: {},
        totalRequests: 0,
        activeConnections: 0,
        responseTimeSamples: [],
        rateLimitBlocked: 0,
        rateLimitTotal: 0,
        routeStats: new Map<string, RouteStats>(),
        recentErrors: []
    };

    /** Top routes by request count. */
    function getTopRoutes(): RouteStats[] {
        return Array.from(state.routeStats.values())
            .sort((a, b) => b.count - a.count)
            .slice(0, config.maxRoutes);
    }

    /** Slowest routes by average response time. */
    function getSlowestRoutes(): RouteStats[] {
        return Array.from(state.routeStats.values())
            .filter(r => r.count > 0)
            .sort((a, b) => b.avgTime - a.avgTime)
            .slice(0, config.maxRoutes);
    }

    /** Routes with the most errors. */
    function getErrorRoutes(): RouteStats[] {
        return Array.from(state.routeStats.values())
            .filter(r => r.errors > 0)
            .sort((a, b) => b.errors - a.errors)
            .slice(0, config.maxRoutes);
    }

    /** Current error rate as a percentage of all requests. */
    function getErrorRate(): number {
        const totalErrors = Array.from(state.routeStats.values())
            .reduce((sum, r) => sum + r.errors, 0);
        if (state.totalRequests === 0) return 0;
        return round((totalErrors / state.totalRequests) * 100);
    }

    /** Cap distinct tracked routes; evict least-recently-accessed to bound memory. */
    function evictRoutesIfNeeded(): void {
        if (state.routeStats.size < config.maxTrackedRoutes) return;
        let oldestKey: string | null = null;
        let oldestAccess = Infinity;
        for (const [k, v] of state.routeStats) {
            if (v.lastAccess < oldestAccess) {
                oldestAccess = v.lastAccess;
                oldestKey = k;
            }
        }
        if (oldestKey) state.routeStats.delete(oldestKey);
    }

    /** Append a data point and drop anything older than the retention window. */
    function addToHistory(history: MetricDataPoint[], value: number): void {
        const now = Date.now();
        history.push({ timestamp: now, value });

        const cutoff = now - (config.retentionSeconds * 1000);
        while (history.length > 0 && history[0].timestamp < cutoff) {
            history.shift();
        }
    }

    /** Track a request start. */
    function trackRequest(path: string, method: string): void {
        state.requestCount++;
        state.totalRequests++;
        state.activeConnections++;

        const normalizedPath = config.normalizePath(path);
        const key = `${method}:${normalizedPath}`;

        if (!state.routeStats.has(key)) {
            evictRoutesIfNeeded();
            state.routeStats.set(key, {
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

    /** Track request completion: timings, status codes, route stats, errors. */
    function trackRequestComplete(
        path: string,
        method: string,
        durationMs: number,
        statusCode: number
    ): void {
        state.activeConnections = Math.max(0, state.activeConnections - 1);

        state.totalResponseTime += durationMs;
        state.responseTimeCount++;
        state.responseTimeSamples.push(durationMs);

        const codeStr = statusCode.toString();
        state.statusCodes[codeStr] = (state.statusCodes[codeStr] || 0) + 1;

        const normalizedPath = config.normalizePath(path);
        const key = `${method}:${normalizedPath}`;
        const stats = state.routeStats.get(key);

        if (stats) {
            stats.count++;
            stats.totalTime += durationMs;
            stats.avgTime = stats.totalTime / stats.count;
            stats.minTime = Math.min(stats.minTime, durationMs);
            stats.maxTime = Math.max(stats.maxTime, durationMs);
            stats.lastAccess = Date.now();

            if (statusCode >= 400) {
                stats.errors++;

                state.recentErrors.unshift({
                    timestamp: Date.now(),
                    path: normalizedPath,
                    method,
                    status: statusCode,
                    message: `${method} ${normalizedPath} returned ${statusCode}`
                });

                while (state.recentErrors.length > config.maxRecentErrors) {
                    state.recentErrors.pop();
                }
            }
        }

        options.onRequestComplete?.();
    }

    /** Track a rate limit decision. */
    function trackRateLimitEvent(blocked: boolean): void {
        state.rateLimitTotal++;
        if (blocked) state.rateLimitBlocked++;
    }

    /** Run configured named health checks (falls back to the single healthCheck). */
    async function getHealthReport(): Promise<HealthReport> {
        const checks = config.healthChecks
            ? Object.entries(config.healthChecks)
            : ([['database', config.healthCheck]] as [string, () => Promise<HealthCheckResult>][]);

        const results: NamedHealthResult[] = await Promise.all(
            checks.map(async ([name, fn]) => {
                try {
                    const start = performance.now();
                    const r = await fn();
                    return {
                        name: r.name || name,
                        connected: r.connected,
                        latencyMs: r.latencyMs || round(performance.now() - start),
                        details: r.details
                    };
                } catch (err) {
                    return {
                        name,
                        connected: false,
                        latencyMs: 0,
                        details: { error: err instanceof Error ? err.message : String(err) }
                    };
                }
            })
        );

        return {
            status: results.every(r => r.connected) ? 'ok' : 'degraded',
            uptime: options.uptimeSeconds(),
            timestamp: Date.now(),
            checks: results
        };
    }

    /**
     * Clear the shared counters. Each monitor is responsible for clearing its
     * own platform-specific histories.
     */
    function resetCounters(): void {
        state.requestCount = 0;
        state.lastRequestCount = 0;
        state.totalResponseTime = 0;
        state.responseTimeCount = 0;
        state.statusCodes = {};
        state.totalRequests = 0;
        state.activeConnections = 0;
        state.routeStats.clear();
        state.recentErrors.length = 0;
        state.responseTimeSamples = [];
        state.rateLimitBlocked = 0;
        state.rateLimitTotal = 0;
    }

    return {
        state,
        getTopRoutes,
        getSlowestRoutes,
        getErrorRoutes,
        getErrorRate,
        evictRoutesIfNeeded,
        addToHistory,
        trackRequest,
        trackRequestComplete,
        trackRateLimitEvent,
        getHealthReport,
        resetCounters
    };
}

export type StatsCore = ReturnType<typeof createStatsCore>;
