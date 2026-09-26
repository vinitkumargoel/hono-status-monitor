// =============================================================================
// HONO STATUS MONITOR - EDGE-COMPATIBLE MONITOR
// Lightweight monitor for Cloudflare Workers and Edge environments
// No Node.js-specific APIs (os, process, cluster, socket.io)
// =============================================================================

import type {
    StatusMonitorConfig,
    MetricDataPoint,
    AlertStatus,
    AlertEvent,
    HealthCheckResult,
    MetricsSnapshot,
    ChartData,
    StatusStore
} from './types.js';
import { calculatePercentiles, defaultNormalizePath, formatUptime, round } from './metrics-utils.js';
import { persistSnapshot, loadPeerSnapshots, mergeSnapshots, generateInstanceId } from './edge-store.js';
import { createStatsCore, DEFAULT_HEALTH_CHECK } from './stats-core.js';
import { mergeConfig, sanitizeConfig } from './config.js';
import { detectPlatform } from './platform.js';

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
    healthCheck: DEFAULT_HEALTH_CHECK,
    healthCheckTimeout: 0, // no timeout unless configured
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
    securityHeaders: false,
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
    const config: Required<StatusMonitorConfig> = sanitizeConfig(mergeConfig(DEFAULT_EDGE_CONFIG, userConfig, {
        normalizePath: userConfig.normalizePath || defaultNormalizePath,
        clusterMode: false // Never in cluster mode on edge
    }), DEFAULT_EDGE_CONFIG);

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
            responseTime: responseTimeHistory.length > 0
                ? responseTimeHistory[responseTimeHistory.length - 1].value
                : 0,
            rps: rpsHistory.length > 0
                ? rpsHistory[rpsHistory.length - 1].value
                : 0,
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
        trackRequest: core.trackRequest,
        trackRequestComplete: core.trackRequestComplete,
        trackRateLimitEvent: core.trackRateLimitEvent,
        getMetricsSnapshot,
        getChartData,
        getHealthReport: core.getHealthReport,
        healthConfigured: core.healthConfigured,
        resetStats,
        start,
        stop,
        initSocket,
        formatUptime,
        isEdgeMode: true,
        get io() { return null; }
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
