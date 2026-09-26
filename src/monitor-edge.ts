// =============================================================================
// HONO STATUS MONITOR - EDGE-COMPATIBLE MONITOR
// Lightweight monitor for Cloudflare Workers and Edge environments
// No Node.js-specific APIs (os, process, cluster, socket.io)
// =============================================================================

import type {
    StatusMonitorConfig,
    MetricDataPoint,
    AlertStatus,
    MetricsSnapshot,
    ChartData
} from './types.js';
import { calculatePercentiles, defaultNormalizePath, formatUptime, latest, round } from './metrics-utils.js';
import { persistSnapshot, loadPeerSnapshots, mergeSnapshots, generateInstanceId } from './edge-store.js';
import { createStatsCore } from './stats-core.js';
import { baseDefaults, mergeConfig, resolveLogger, validateConfig } from './config.js';
import { detectPlatform } from './platform.js';

// Default configuration
const DEFAULT_EDGE_CONFIG: Required<StatusMonitorConfig> = {
    ...baseDefaults(),
    pollingInterval: 5000, // Dashboard polling interval (5s for edge)
    updateInterval: 5000, // History bucket width; rolls forward on requests
    clusterMode: false // Not supported in edge
};

/**
 * Create an edge-compatible status monitor instance
 * Works without Node.js APIs (os, process, cluster)
 */
export function createEdgeMonitor(userConfig: StatusMonitorConfig = {}) {
    // Merge configuration
    const logger = resolveLogger(userConfig.logger);
    const config: Required<StatusMonitorConfig> = validateConfig(mergeConfig(DEFAULT_EDGE_CONFIG, userConfig, {
        normalizePath: userConfig.normalizePath || defaultNormalizePath,
        clusterMode: false // Never in cluster mode on edge
    }));


    const runtime = describeEdgeRuntime();

    // In-memory metrics storage
    let responseTimeHistory: MetricDataPoint[] = [];
    let rpsHistory: MetricDataPoint[] = [];
    let errorRateHistory: MetricDataPoint[] = [];

    let lastUpdateTime = Date.now();

    // Alert transition state (for onAlert callbacks)
    let lastAlertState: AlertStatus = {
        cpu: false, memory: false, responseTime: false, errorRate: false, eventLoopLag: false
    };

    // Cross-isolate store state (opt-in via config.store)
    const instanceId = config.instanceId || generateInstanceId();
    let lastPersistTime = 0;

    // Start time for uptime calculation
    const startTime = Date.now();

    // Shared request/route/error accounting.
    const core = createStatsCore(config, {
        // Edge has no interval timer, so history rolls forward on each request.
        onRequestComplete: () => updateMetricsIfNeeded(),
        uptimeSeconds: () => Math.round((Date.now() - startTime) / 1000)
    });
    const { state, getErrorRate, addToHistory } = core;

    /**
     * Check alert conditions (limited to available metrics)
     */
    function checkAlerts(): AlertStatus {
        const respTime = latest(responseTimeHistory);
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
        const respTime = latest(responseTimeHistory);
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

    // Clear accumulated request/route/error counters.
    function resetStats(): void {
        responseTimeHistory = [];
        rpsHistory = [];
        errorRateHistory = [];
        core.resetCounters();
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
            const currentRps = round((state.requestCount - state.lastRequestCount) / intervalSeconds);
            state.lastRequestCount = state.requestCount;
            lastUpdateTime = now;

            addToHistory(rpsHistory, currentRps);

            const avgResponseTime = state.responseTimeCount > 0
                ? round(state.totalResponseTime / state.responseTimeCount)
                : 0;
            addToHistory(responseTimeHistory, avgResponseTime);
            addToHistory(errorRateHistory, getErrorRate());

            fireAlertTransitions();

            // Reset counters
            state.totalResponseTime = 0;
            state.responseTimeCount = 0;
        }
    }

    /**
     * Build this isolate's own metrics snapshot (no cross-isolate aggregation).
     */
    async function getLocalSnapshot(): Promise<MetricsSnapshot> {
        // Trigger update check
        updateMetricsIfNeeded();

        const uptimeSeconds = Math.round((Date.now() - startTime) / 1000);
        const routeLists = core.getRouteLists();

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
            responseTime: latest(responseTimeHistory),
            rps: latest(rpsHistory),
            statusCodes: { ...state.statusCodes },
            totalRequests: state.totalRequests,
            activeConnections: state.activeConnections,
            eventLoopLag: 0, // Not available in edge
            // Platform info
            hostname: runtime.hostname,
            platform: runtime.label,
            nodeVersion: 'N/A',
            pid: 0,
            cpuCount: 0,
            // Analytics - available
            percentiles: calculatePercentiles(state.responseTimeSamples),
            topRoutes: routeLists.topRoutes,
            slowestRoutes: routeLists.slowestRoutes,
            errorRoutes: routeLists.errorRoutes,
            recentErrors: [...state.recentErrors],
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
            rateLimitStats: { blocked: state.rateLimitBlocked, total: state.rateLimitTotal },
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
        peerCache = null; // Our write is a good moment to refresh peers too.
        const ttlSeconds = Math.max(config.retentionSeconds, (config.storeWriteInterval / 1000) * 3);
        await persistSnapshot(config.store, instanceId, snapshot, ttlSeconds);
    }

    /**
     * After each tracked request: persist this isolate's numbers when a write
     * is due. Without this only isolates that served the dashboard ever wrote
     * to the store, so the fleet view missed every isolate that just served
     * traffic. Uses `waitUntil` so the write doesn't delay the response or get
     * cut off when the isolate finishes the request.
     */
    let persisting = false;
    function afterRequest(c: any): void {
        if (!config.store || persisting || Date.now() - lastPersistTime < config.storeWriteInterval) return;
        // Set synchronously so concurrent requests at the boundary don't each
        // build a snapshot before the first write updates lastPersistTime.
        persisting = true;
        const work = getLocalSnapshot().then(maybePersist).catch(() => { /* best-effort */ })
            .finally(() => { persisting = false; });
        let ctx: { waitUntil?: (p: Promise<unknown>) => void } | undefined;
        try {
            // Hono throws when the runtime provides no ExecutionContext.
            ctx = c?.executionCtx;
        } catch {
            ctx = undefined;
        }
        try {
            ctx?.waitUntil?.(work);
        } catch {
            /* fire-and-forget; `work` never rejects */
        }
    }

    // Peer snapshots only change when a peer writes (every storeWriteInterval),
    // so re-reading them on every dashboard poll is wasted KV reads.
    const peerCacheMs = Math.min(config.storeWriteInterval, 30_000);
    let peerCache: { at: number; peers: Promise<MetricsSnapshot[]> } | null = null;

    function getPeers(): Promise<MetricsSnapshot[]> {
        if (peerCache && Date.now() - peerCache.at < peerCacheMs) return peerCache.peers;
        const peers = loadPeerSnapshots(config.store, instanceId, config.maxPeers);
        peerCache = { at: Date.now(), peers };
        return peers;
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
            const peers = await getPeers();
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

    // Nothing to schedule on edge: numbers are updated per request. Silent,
    // since every isolate would otherwise log on its first request.
    function start(): void {}
    function stop(): void {}

    return {
        config,
        trackRequest: core.trackRequest,
        trackRequestComplete: core.trackRequestComplete,
        beginRequest: core.beginRequest,
        endRequest: core.endRequest,
        getHistograms: core.getHistograms,
        logger,
        trackRateLimitEvent: core.trackRateLimitEvent,
        getMetricsSnapshot,
        getChartData,
        getHealthReport: core.getHealthReport,
        healthConfigured: core.healthConfigured,
        resetStats,
        afterRequest,
        start,
        stop,
        formatUptime,
        isEdgeMode: true
    };
}

/**
 * Name the edge runtime for the snapshot and dashboard. Cloudflare keeps the
 * values it has always reported; Deno and Vercel Edge were previously
 * mislabelled as Cloudflare.
 */
export function describeEdgeRuntime(): { hostname: string; label: string } {
    if (detectPlatform() === 'cloudflare') {
        return { hostname: 'cloudflare-worker', label: 'Cloudflare Workers' };
    }
    const g = globalThis as { Deno?: unknown; EdgeRuntime?: unknown };
    if (typeof g.Deno !== 'undefined') return { hostname: 'deno', label: 'Deno' };
    if (typeof g.EdgeRuntime !== 'undefined') return { hostname: 'vercel-edge', label: 'Vercel Edge' };
    // Unknown edge runtimes (and Node/Bun importing the edge entry directly)
    // keep the historical Cloudflare label, so nothing changes for them.
    return { hostname: 'cloudflare-worker', label: 'Cloudflare Workers' };
}

export type EdgeMonitor = ReturnType<typeof createEdgeMonitor>;
