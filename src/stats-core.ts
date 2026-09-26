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

/** Cap on retained latency samples; percentiles are computed from these. */
const MAX_RESPONSE_TIME_SAMPLES = 1000;

/** Cap on memoised raw-path -> normalized-path entries. */
const MAX_NORMALIZE_CACHE = 1000;

/**
 * How long a health report is reused. Short enough that `/health` stays fresh
 * for probes, long enough that N dashboard tabs or SSE clients polling at once
 * cost one round of checks rather than N.
 */
const HEALTH_CACHE_MS = 1000;

/**
 * The placeholder used when no `healthCheck` is configured. Exported so the
 * monitors can share one identity and the core can tell "configured" from
 * "defaulted".
 */
export const DEFAULT_HEALTH_CHECK = async (): Promise<HealthCheckResult> => ({ connected: true, latencyMs: 0 });

/** Route lists derived from one pass over the tracked routes. */
export interface RouteLists {
    topRoutes: RouteStats[];
    slowestRoutes: RouteStats[];
    errorRoutes: RouteStats[];
}

/**
 * Race `fn()` against a timeout. The timer is unref'd so a pending check never
 * keeps the process alive, and cleared as soon as either side settles.
 */
export async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        (timer as { unref?: () => void }).unref?.();
    });
    try {
        return await Promise.race([fn(), timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

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
    /** Sum of `errors` across tracked routes, kept incrementally. */
    totalErrors: number;
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
        totalErrors: 0,
        routeStats: new Map<string, RouteStats>(),
        recentErrors: []
    };

    const normalizeCache = new Map<string, string>();

    /**
     * `config.normalizePath` memoised per raw path. Every request normalizes its
     * path twice (start and completion), and the default normalizer is three
     * regex passes; a Map hit is far cheaper. Cleared wholesale when full so a
     * flood of unique paths can't grow it without bound.
     */
    function normalize(path: string): string {
        const hit = normalizeCache.get(path);
        if (hit !== undefined) return hit;
        const normalized = config.normalizePath(path);
        if (normalizeCache.size >= MAX_NORMALIZE_CACHE) normalizeCache.clear();
        normalizeCache.set(path, normalized);
        return normalized;
    }

    /**
     * Top, slowest and error route lists from a single copy of the route map.
     * Snapshots need all three, so deriving them together avoids copying the
     * map three times.
     */
    function getRouteLists(): RouteLists {
        const routes = Array.from(state.routeStats.values());
        const max = config.maxRoutes;
        return {
            topRoutes: [...routes].sort((a, b) => b.count - a.count).slice(0, max),
            slowestRoutes: routes.filter(r => r.count > 0).sort((a, b) => b.avgTime - a.avgTime).slice(0, max),
            errorRoutes: routes.filter(r => r.errors > 0).sort((a, b) => b.errors - a.errors).slice(0, max)
        };
    }

    /** Top routes by request count. */
    function getTopRoutes(): RouteStats[] {
        return getRouteLists().topRoutes;
    }

    /** Slowest routes by average response time. */
    function getSlowestRoutes(): RouteStats[] {
        return getRouteLists().slowestRoutes;
    }

    /** Routes with the most errors. */
    function getErrorRoutes(): RouteStats[] {
        return getRouteLists().errorRoutes;
    }

    /** Current error rate as a percentage of all requests. O(1). */
    function getErrorRate(): number {
        if (state.totalRequests === 0) return 0;
        return round((state.totalErrors / state.totalRequests) * 100);
    }

    /**
     * Cap distinct tracked routes; evict least-recently-used to bound memory.
     *
     * A Map iterates in insertion order and `touchRoute` re-inserts on access,
     * so the first key is always the least recently used. That makes eviction
     * O(1) rather than a scan of every tracked route — which mattered because
     * eviction runs on every *new* route once at the cap, and a flood of
     * distinct paths is exactly the case the cap exists to survive.
     */
    function evictRoutesIfNeeded(): void {
        if (state.routeStats.size < config.maxTrackedRoutes) return;
        const oldest = state.routeStats.keys().next().value;
        if (oldest === undefined) return;
        // Evicted routes drop out of the error total too, matching the rate a
        // full scan of the remaining routes would give.
        state.totalErrors -= state.routeStats.get(oldest)?.errors ?? 0;
        state.routeStats.delete(oldest);
    }

    /** Move a route to the most-recently-used end of the iteration order. */
    function touchRoute(key: string, stats: RouteStats): void {
        stats.lastAccess = Date.now();
        state.routeStats.delete(key);
        state.routeStats.set(key, stats);
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

        const normalizedPath = normalize(path);
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

        // Bounded here rather than in the callers: the core owns this array, so
        // the cap has to travel with it. Halving on overflow amortises the copy.
        state.responseTimeSamples.push(durationMs);
        if (state.responseTimeSamples.length > MAX_RESPONSE_TIME_SAMPLES) {
            state.responseTimeSamples = state.responseTimeSamples.slice(-MAX_RESPONSE_TIME_SAMPLES / 2);
        }

        const codeStr = statusCode.toString();
        state.statusCodes[codeStr] = (state.statusCodes[codeStr] || 0) + 1;

        const normalizedPath = normalize(path);
        const key = `${method}:${normalizedPath}`;
        const stats = state.routeStats.get(key);

        if (stats) {
            stats.count++;
            stats.totalTime += durationMs;
            stats.avgTime = stats.totalTime / stats.count;
            stats.minTime = Math.min(stats.minTime, durationMs);
            stats.maxTime = Math.max(stats.maxTime, durationMs);
            touchRoute(key, stats);

            if (statusCode >= 400) {
                stats.errors++;
                state.totalErrors++;

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

    /** Whether the user supplied any health check (vs. the built-in placeholder). */
    const healthConfigured = !!config.healthChecks || config.healthCheck !== DEFAULT_HEALTH_CHECK;

    let healthCache: { at: number; report: HealthReport } | null = null;
    let healthInFlight: Promise<HealthReport> | null = null;

    /**
     * Run configured named health checks (falls back to the single healthCheck).
     * Concurrent callers share one in-flight run, and a result is reused for
     * HEALTH_CACHE_MS, so health checks cost the same with one viewer or fifty.
     */
    function getHealthReport(): Promise<HealthReport> {
        if (healthCache && Date.now() - healthCache.at < HEALTH_CACHE_MS) {
            return Promise.resolve(healthCache.report);
        }
        if (healthInFlight) return healthInFlight;
        healthInFlight = runHealthChecks()
            .then((report) => {
                healthCache = { at: Date.now(), report };
                return report;
            })
            .finally(() => {
                healthInFlight = null;
            });
        return healthInFlight;
    }

    async function runHealthChecks(): Promise<HealthReport> {
        const checks = config.healthChecks
            ? Object.entries(config.healthChecks)
            : ([['database', config.healthCheck]] as [string, () => Promise<HealthCheckResult>][]);

        const results: NamedHealthResult[] = await Promise.all(
            checks.map(async ([name, fn]) => {
                try {
                    const start = performance.now();
                    const r = await withTimeout(fn, config.healthCheckTimeout, `health check "${name}"`);
                    return {
                        name: r.name || name,
                        connected: r.connected,
                        // `??` not `||`: a check legitimately reporting 0 ms must
                        // not be overwritten with our own measurement.
                        latencyMs: r.latencyMs ?? round(performance.now() - start),
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
            configured: healthConfigured,
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
        state.totalErrors = 0;
        healthCache = null;
    }

    return {
        state,
        getTopRoutes,
        getSlowestRoutes,
        getErrorRoutes,
        getRouteLists,
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
