// =============================================================================
// HONO STATUS MONITOR - SHARED STATS CORE
// Platform-independent request/route/error accounting, shared by the Node and
// edge monitors. Holds the mutable counters both implementations read from.
// =============================================================================

import type {
    HealthCheckDefinition,
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

/** Outcome of one health-check call: its result or error, and how long it took. */
export interface CheckOutcome {
    result?: HealthCheckResult;
    error?: unknown;
    elapsedMs: number;
}

/** Prometheus-style latency buckets, in seconds (upper bounds; +Inf implied). */
export const HISTOGRAM_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

interface HistogramCounts {
    /** Cumulative count per bucket (<= upper bound). */
    buckets: number[];
    sum: number;
    count: number;
}

/** One latency histogram series, as exported to Prometheus. */
export interface RouteHistogram extends HistogramCounts {
    method: string;
    route: string;
    status: number;
}

/** Route lists derived from one pass over the tracked routes. */
export interface RouteLists {
    topRoutes: RouteStats[];
    slowestRoutes: RouteStats[];
    errorRoutes: RouteStats[];
}

/**
 * Race `fn()` against a timeout. The timer is unref'd so a pending check never
 * keeps the process alive, and cleared as soon as either side settles.
 * `ms <= 0` disables the timeout.
 */
export async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
    if (!(ms > 0)) return fn();
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
    /**
     * Requests that were in flight when the counters were reset. Their
     * completions are dropped so a reset really starts from zero.
     */
    staleCompletions: number;
    /** Errors among requests left out by `sampleRate`. */
    unsampledErrors: number;
    readonly routeStats: Map<string, RouteStats>;
    /** Latency histograms, keyed like routeStats: key -> status -> buckets. */
    readonly histograms: Map<string, Map<number, HistogramCounts>>;
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
        staleCompletions: 0,
        unsampledErrors: 0,
        routeStats: new Map<string, RouteStats>(),
        histograms: new Map(),
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
        return round(((state.totalErrors + state.unsampledErrors) / state.totalRequests) * 100);
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
        state.histograms.delete(oldest);
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

    /** Create a route entry at the most-recently-used end, evicting if full. */
    function ensureRoute(key: string, path: string, method: string): RouteStats {
        let stats = state.routeStats.get(key);
        if (!stats) {
            evictRoutesIfNeeded();
            stats = {
                path,
                method,
                count: 0,
                totalTime: 0,
                avgTime: 0,
                minTime: Infinity,
                maxTime: 0,
                errors: 0,
                lastAccess: Date.now()
            };
            state.routeStats.set(key, stats);
        }
        return stats;
    }

    /** Count a request start: throughput and in-flight counters only. */
    function beginRequest(): void {
        state.requestCount++;
        state.totalRequests++;
        state.activeConnections++;
    }

    /** Track a request start. */
    function trackRequest(path: string, method: string): void {
        beginRequest();
        const normalizedPath = normalize(path);
        ensureRoute(`${method}:${normalizedPath}`, normalizedPath, method);
    }

    /**
     * Shared completion accounting. `route` is already grouped (normalized path
     * or route pattern). `createRoute` is false for the legacy
     * trackRequestComplete path, which only updates routes trackRequest created.
     */
    function complete(
        route: string,
        method: string,
        durationMs: number,
        statusCode: number,
        createRoute: boolean
    ): void {
        if (state.staleCompletions > 0) {
            state.staleCompletions--;
            return;
        }
        state.activeConnections = Math.max(0, state.activeConnections - 1);

        const codeStr = statusCode.toString();
        state.statusCodes[codeStr] = (state.statusCodes[codeStr] || 0) + 1;

        // Sampled-out requests still count toward throughput, status codes and
        // the error rate above/below; only their timing is skipped.
        const sampled = config.sampleRate >= 1 || Math.random() < config.sampleRate;
        if (!sampled) {
            if (statusCode >= 400) state.unsampledErrors++;
            options.onRequestComplete?.();
            return;
        }

        state.totalResponseTime += durationMs;
        state.responseTimeCount++;

        // Bounded here rather than in the callers: the core owns this array, so
        // the cap has to travel with it. Halving on overflow amortises the copy.
        state.responseTimeSamples.push(durationMs);
        if (state.responseTimeSamples.length > MAX_RESPONSE_TIME_SAMPLES) {
            state.responseTimeSamples = state.responseTimeSamples.slice(-MAX_RESPONSE_TIME_SAMPLES / 2);
        }

        const key = `${method}:${route}`;
        const stats = createRoute ? ensureRoute(key, route, method) : state.routeStats.get(key);

        if (stats) {
            stats.count++;
            stats.totalTime += durationMs;
            stats.avgTime = stats.totalTime / stats.count;
            stats.minTime = Math.min(stats.minTime, durationMs);
            stats.maxTime = Math.max(stats.maxTime, durationMs);
            touchRoute(key, stats);
            if (config.prometheusHistogram) observeHistogram(key, statusCode, durationMs);

            if (statusCode >= 400) {
                stats.errors++;
                state.totalErrors++;

                state.recentErrors.unshift({
                    timestamp: Date.now(),
                    path: route,
                    method,
                    status: statusCode,
                    message: `${method} ${route} returned ${statusCode}`
                });

                while (state.recentErrors.length > config.maxRecentErrors) {
                    state.recentErrors.pop();
                }
            }
        }

        options.onRequestComplete?.();
    }

    /** Track request completion: timings, status codes, route stats, errors. */
    function trackRequestComplete(
        path: string,
        method: string,
        durationMs: number,
        statusCode: number
    ): void {
        complete(normalize(path), method, durationMs, statusCode, false);
    }

    /**
     * Completion for requests started with `beginRequest`. `route` is either a
     * raw path (normalized here) or, with `isPattern`, a Hono route pattern
     * used as-is.
     */
    function endRequest(
        route: string,
        method: string,
        durationMs: number,
        statusCode: number,
        isPattern = false
    ): void {
        complete(isPattern ? route : normalize(route), method, durationMs, statusCode, true);
    }

    /**
     * Latency histograms per route and status, for Prometheus. Keyed like
     * routeStats and evicted with it, so they share its memory bound.
     */
    function observeHistogram(key: string, statusCode: number, durationMs: number): void {
        let byStatus = state.histograms.get(key);
        if (!byStatus) {
            byStatus = new Map();
            state.histograms.set(key, byStatus);
        }
        let h = byStatus.get(statusCode);
        if (!h) {
            h = { buckets: new Array(HISTOGRAM_BUCKETS_SECONDS.length).fill(0), sum: 0, count: 0 };
            byStatus.set(statusCode, h);
        }
        const seconds = durationMs / 1000;
        h.sum += seconds;
        h.count++;
        for (let i = 0; i < HISTOGRAM_BUCKETS_SECONDS.length; i++) {
            if (seconds <= HISTOGRAM_BUCKETS_SECONDS[i]) h.buckets[i]++;
        }
    }

    /** Snapshot of the latency histograms (cumulative bucket counts). */
    function getHistograms(): RouteHistogram[] {
        const out: RouteHistogram[] = [];
        for (const [key, byStatus] of state.histograms) {
            const route = state.routeStats.get(key);
            if (!route) continue;
            for (const [status, h] of byStatus) {
                out.push({ method: route.method, route: route.path, status, buckets: [...h.buckets], sum: h.sum, count: h.count });
            }
        }
        return out;
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
     * `maxAgeMs` (default HEALTH_CACHE_MS), so health checks cost the same with
     * one viewer or fifty.
     */
    function getHealthReport(maxAgeMs: number = HEALTH_CACHE_MS): Promise<HealthReport> {
        if (healthCache && Date.now() - healthCache.at < maxAgeMs) {
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

    const checkCache = new Map<() => Promise<HealthCheckResult>, { at: number; outcome: Promise<CheckOutcome> }>();

    /**
     * Call one health-check function, sharing the call between concurrent
     * callers and reusing its outcome for HEALTH_CACHE_MS. Both the health
     * report and the Node snapshot's `database` field go through here, so a
     * single `healthCheck` runs once per window no matter who asks.
     * Never rejects.
     */
    function runCheck(
        fn: () => Promise<HealthCheckResult>,
        label: string,
        timeoutMs: number = config.healthCheckTimeout
    ): Promise<CheckOutcome> {
        const hit = checkCache.get(fn);
        if (hit && Date.now() - hit.at < HEALTH_CACHE_MS) return hit.outcome;
        const start = performance.now();
        const elapsed = () => round(performance.now() - start);
        const outcome = withTimeout(fn, timeoutMs, label).then(
            (result): CheckOutcome => ({ result, elapsedMs: elapsed() }),
            (error): CheckOutcome => ({ error, elapsedMs: elapsed() })
        );
        checkCache.set(fn, { at: Date.now(), outcome });
        return outcome;
    }

    /** Configured checks as uniform definitions. */
    const checkDefinitions: Array<{ name: string } & Required<Omit<HealthCheckDefinition, 'timeoutMs'>> & { timeoutMs?: number }> =
        config.healthChecks
            ? Object.entries(config.healthChecks).map(([name, def]) =>
                typeof def === 'function'
                    ? { name, check: def, required: true }
                    : { name, check: def.check, required: def.required !== false, timeoutMs: def.timeoutMs })
            : [{ name: 'database', check: config.healthCheck, required: true }];

    async function runHealthChecks(): Promise<HealthReport> {
        const results: NamedHealthResult[] = await Promise.all(
            checkDefinitions.map(async ({ name, check, required, timeoutMs }): Promise<NamedHealthResult> => {
                const { result: r, error, elapsedMs } = await runCheck(check, `health check "${name}"`, timeoutMs);
                // Only report `required` when it departs from the default, so
                // existing payloads are unchanged.
                const flag = required ? {} : { required: false };
                if (r) {
                    return {
                        name: r.name || name,
                        connected: r.connected,
                        // `??` not `||`: a check legitimately reporting 0 ms must
                        // not be overwritten with our own measurement.
                        latencyMs: r.latencyMs ?? elapsedMs,
                        details: r.details,
                        ...flag
                    };
                }
                return {
                    name,
                    connected: false,
                    // How long we waited — for a timeout, that's the timeout.
                    latencyMs: elapsedMs,
                    details: { error: error instanceof Error ? error.message : String(error) },
                    ...flag
                };
            })
        );

        return {
            status: results.every(r => r.connected || r.required === false) ? 'ok' : 'degraded',
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
        state.staleCompletions += state.activeConnections;
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
        state.unsampledErrors = 0;
        state.histograms.clear();
        healthCache = null;
        checkCache.clear();
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
        beginRequest,
        endRequest,
        getHistograms,
        trackRateLimitEvent,
        getHealthReport,
        runCheck,
        healthConfigured,
        resetCounters
    };
}

export type StatsCore = ReturnType<typeof createStatsCore>;
