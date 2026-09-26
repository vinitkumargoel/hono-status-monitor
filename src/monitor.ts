// =============================================================================
// HONO STATUS MONITOR - CORE METRICS SERVICE
// Real-time server metrics collection (polling-based, no external dependencies)
// =============================================================================

import * as os from 'node:os';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import type {
    StatusMonitorConfig,
    MetricDataPoint,
    AlertStatus,
    AlertEvent,
    DatabaseStats,
    HealthCheckResult,
    MetricsSnapshot,
    ChartData,
    StatusStore
} from './types.js';
import {
    isClusterWorker,
    sendMetricsToMaster,
    createClusterAggregator,
    isWorkerMetricsMessage,
    type ClusterAggregator
} from './cluster.js';
import { calculatePercentiles, defaultNormalizePath, formatUptime, round } from './metrics-utils.js';
import { detectPlatform } from './platform.js';
import { createStatsCore, DEFAULT_HEALTH_CHECK } from './stats-core.js';
import { mergeConfig, sanitizeConfig } from './config.js';

// Default configuration
const DEFAULT_CONFIG: Required<StatusMonitorConfig> = {
    path: '/status',
    title: 'Server Status',
    socketPath: '/status/socket.io', // Kept for compatibility, but not used
    pollingInterval: 1000, // Dashboard polling interval
    updateInterval: 1000,
    retentionSeconds: 60,
    maxRecentErrors: 10,
    maxRoutes: 10,
    maxTrackedRoutes: 1000,
    alerts: {
        cpu: 80,
        memory: 90,
        responseTime: 500,
        errorRate: 5,
        eventLoopLag: 100
    },
    healthCheck: DEFAULT_HEALTH_CHECK,
    healthCheckTimeout: 0, // no timeout unless configured
    healthChecks: undefined as unknown as Record<string, () => Promise<HealthCheckResult>>,
    normalizePath: (path: string) => path,
    clusterMode: undefined as unknown as boolean, // Will be auto-detected
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
 * Create a status monitor instance
 */
export function createMonitor(userConfig: StatusMonitorConfig = {}) {
    const inClusterMode = userConfig.clusterMode ?? isClusterWorker();

    const config: Required<StatusMonitorConfig> = sanitizeConfig(mergeConfig(DEFAULT_CONFIG, userConfig, {
        normalizePath: userConfig.normalizePath || defaultNormalizePath,
        clusterMode: inClusterMode
    }), DEFAULT_CONFIG);

    const clusterAggregator: ClusterAggregator | null = inClusterMode
        ? createClusterAggregator({ maxRoutes: config.maxRoutes })
        : null;

    // In-memory metrics storage
    let cpuHistory: MetricDataPoint[] = [];
    let memoryHistory: MetricDataPoint[] = [];
    let heapHistory: MetricDataPoint[] = [];
    let loadAvgHistory: MetricDataPoint[] = [];
    let responseTimeHistory: MetricDataPoint[] = [];
    let rpsHistory: MetricDataPoint[] = [];
    let eventLoopLagHistory: MetricDataPoint[] = [];
    let errorRateHistory: MetricDataPoint[] = [];

    let lastRpsUpdateTime = Date.now();

    // Shared request/route/error accounting.
    const core = createStatsCore(config, {
        uptimeSeconds: () => Math.round(process.uptime())
    });
    const { state, getErrorRate, addToHistory } = core;

    // GC tracking
    let lastHeapUsed = 0;
    let heapGrowthRate = 0;
    let gcCollections = 0;
    let gcPauseTimeMs = 0;

    // CPU tracking
    let lastCpuInfo: os.CpuInfo[] | null = null;

    // Event loop lag tracking (falls back to interval drift if perf_hooks histogram unavailable)
    let lastLoopTime = Date.now();
    let eventLoopHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
    // GC observer (best-effort; not every runtime emits 'gc' entries)
    let gcObserver: PerformanceObserver | null = null;

    // Arm the high-resolution event-loop histogram and GC observer. Idempotent and
    // called from start(), so a stop()/start() cycle re-arms instrumentation instead
    // of silently degrading to the interval-drift fallback with frozen GC counters.
    function enableInstrumentation(): void {
        if (!eventLoopHistogram) {
            try {
                eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
                eventLoopHistogram.enable();
            } catch {
                eventLoopHistogram = null;
            }
        }
        if (!gcObserver) {
            try {
                gcObserver = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        gcCollections++;
                        gcPauseTimeMs += entry.duration;
                    }
                });
                gcObserver.observe({ entryTypes: ['gc'] });
            } catch {
                gcObserver = null;
            }
        }
    }

    // Alert transition state (for onAlert callbacks)
    let lastAlertState: AlertStatus = {
        cpu: false, memory: false, responseTime: false, errorRate: false, eventLoopLag: false
    };

    // Database latency tracking
    let dbLatency = 0;

    // Metrics collection interval
    let metricsInterval: ReturnType<typeof setInterval> | null = null;

    function getCpuInfo(): os.CpuInfo[] {
        try {
            return os.cpus();
        } catch {
            return [];
        }
    }

    function getSystemUptime(): number {
        try {
            return Math.round(os.uptime());
        } catch {
            return Math.round(process.uptime());
        }
    }

    function getPlatformLabel(): string {
        try {
            return `${os.type()} ${os.release()}`;
        } catch {
            return process.platform;
        }
    }

    function getHostname(): string {
        try {
            return os.hostname();
        } catch {
            return 'unknown';
        }
    }

    function getRuntimeVersion(): string {
        const bunVersion = (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun;
        if (detectPlatform() === 'bun' && bunVersion) {
            return `Bun ${bunVersion}`;
        }

        return process.version;
    }

    function calculateCpuUsage(): number {
        const cpus = getCpuInfo();
        if (cpus.length === 0) return 0;

        if (!lastCpuInfo) {
            lastCpuInfo = cpus;
            return 0;
        }

        let totalIdle = 0;
        let totalTick = 0;

        for (let i = 0; i < cpus.length; i++) {
            const cpu = cpus[i];
            const lastCpu = lastCpuInfo[i];
            if (!lastCpu) continue;

            const idle = cpu.times.idle - lastCpu.times.idle;
            const total =
                (cpu.times.user - lastCpu.times.user) +
                (cpu.times.nice - lastCpu.times.nice) +
                (cpu.times.sys - lastCpu.times.sys) +
                (cpu.times.idle - lastCpu.times.idle) +
                (cpu.times.irq - lastCpu.times.irq);

            totalIdle += idle;
            totalTick += total;
        }

        lastCpuInfo = cpus;

        if (totalTick === 0) return 0;
        return round(((totalTick - totalIdle) / totalTick) * 100, 1);
    }

    function getMemoryMB(): number {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        return round(usedMem / (1024 * 1024), 1);
    }

    function getMemoryPercent(): number {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        return round((usedMem / totalMem) * 100, 1);
    }

    // Pure read — safe to call from snapshots/dashboard polls without skewing growth rate.
    function getHeapUsage(): { used: number; total: number } {
        const mem = process.memoryUsage();
        return {
            used: round(mem.heapUsed / (1024 * 1024), 1),
            total: round(mem.heapTotal / (1024 * 1024), 1)
        };
    }

    // Growth rate is sampled once per collection interval only.
    function measureHeapGrowth(used: number): void {
        if (lastHeapUsed > 0) {
            heapGrowthRate = used - lastHeapUsed;
        }
        lastHeapUsed = used;
    }

    function getLoadAverage(): number {
        try {
            const loadAvg = os.loadavg();
            return round(loadAvg[0]);
        } catch {
            return 0;
        }
    }

    function measureEventLoopLag(): number {
        // Prefer the high-resolution histogram when available.
        if (eventLoopHistogram) {
            const meanMs = eventLoopHistogram.mean / 1e6; // ns -> ms
            eventLoopHistogram.reset();
            if (Number.isFinite(meanMs)) {
                return round(meanMs, 1);
            }
        }

        // Fallback: interval drift.
        const now = Date.now();
        const actualInterval = now - lastLoopTime;
        lastLoopTime = now;
        return round(Math.max(0, actualInterval - config.updateInterval), 1);
    }

    function checkAlerts(): AlertStatus {
        const cpu = cpuHistory.length > 0 ? cpuHistory[cpuHistory.length - 1].value : 0;
        const memory = getMemoryPercent();
        const respTime = responseTimeHistory.length > 0 ? responseTimeHistory[responseTimeHistory.length - 1].value : 0;
        const errorRate = getErrorRate();
        const lag = eventLoopLagHistory.length > 0 ? eventLoopLagHistory[eventLoopLagHistory.length - 1].value : 0;

        return {
            cpu: cpu > (config.alerts.cpu ?? 80),
            memory: memory > (config.alerts.memory ?? 90),
            responseTime: respTime > (config.alerts.responseTime ?? 500),
            errorRate: errorRate > (config.alerts.errorRate ?? 5),
            eventLoopLag: lag > (config.alerts.eventLoopLag ?? 100)
        };
    }

    // Fire onAlert only on OK<->breached transitions, not every tick.
    function fireAlertTransitions(): void {
        if (!config.onAlert) return;

        const current = checkAlerts();
        const values: Record<keyof AlertStatus, number> = {
            cpu: cpuHistory.length > 0 ? cpuHistory[cpuHistory.length - 1].value : 0,
            memory: getMemoryPercent(),
            responseTime: responseTimeHistory.length > 0 ? responseTimeHistory[responseTimeHistory.length - 1].value : 0,
            errorRate: getErrorRate(),
            eventLoopLag: eventLoopLagHistory.length > 0 ? eventLoopLagHistory[eventLoopLagHistory.length - 1].value : 0
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
                        metric,
                        active: current[metric],
                        value: values[metric],
                        threshold: thresholds[metric],
                        timestamp: Date.now()
                    });
                } catch {
                    // Never let a user callback break the metrics loop.
                }
            }
        });
        lastAlertState = current;
    }

    async function getDatabaseStats(): Promise<DatabaseStats> {
        // Shared with the health report (same call, same cache window).
        const { result, elapsedMs } = await core.runCheck(config.healthCheck, 'healthCheck');
        try {
            if (!result) throw new Error('health check failed');
            dbLatency = elapsedMs;

            // Pool figures are only meaningful if the health check surfaces them.
            const details = (result.details ?? {}) as Record<string, number>;
            const poolSize = typeof details.poolSize === 'number' ? details.poolSize : 0;
            const available = typeof details.availableConnections === 'number'
                ? details.availableConnections
                : (result.connected ? poolSize : 0);

            return {
                connected: result.connected,
                poolSize,
                availableConnections: available,
                waitQueueSize: typeof details.waitQueueSize === 'number' ? details.waitQueueSize : 0,
                latencyMs: result.latencyMs || dbLatency,
                name: result.name
            };
        } catch {
            return {
                connected: false,
                poolSize: 0,
                availableConnections: 0,
                waitQueueSize: 0,
                latencyMs: 0
            };
        }
    }

    async function updateMetrics(): Promise<void> {
        const heap = getHeapUsage();
        measureHeapGrowth(heap.used);
        const eventLoopLag = measureEventLoopLag();
        const errorRate = getErrorRate();

        addToHistory(cpuHistory, calculateCpuUsage());
        addToHistory(memoryHistory, getMemoryMB());
        addToHistory(heapHistory, heap.used);
        addToHistory(loadAvgHistory, getLoadAverage());
        addToHistory(eventLoopLagHistory, eventLoopLag);
        addToHistory(errorRateHistory, errorRate);

        fireAlertTransitions();

        const now = Date.now();
        const elapsedSeconds = Math.max((now - lastRpsUpdateTime) / 1000, config.updateInterval / 1000);
        const currentRps = round((state.requestCount - state.lastRequestCount) / elapsedSeconds);
        state.lastRequestCount = state.requestCount;
        lastRpsUpdateTime = now;
        addToHistory(rpsHistory, currentRps);

        const avgResponseTime = state.responseTimeCount > 0
            ? round(state.totalResponseTime / state.responseTimeCount)
            : 0;
        addToHistory(responseTimeHistory, avgResponseTime);

        state.totalResponseTime = 0;
        state.responseTimeCount = 0;

        // In cluster mode, send metrics to master for aggregation
        if (config.clusterMode && process.send) {
            const dbStats = await getDatabaseStats();
            const snapshot = await getMetricsSnapshot(dbStats);
            const charts = getChartData();
            sendMetricsToMaster(snapshot, charts);
        }
    }

    async function getMetricsSnapshot(dbStats?: DatabaseStats): Promise<MetricsSnapshot> {
        const heap = getHeapUsage();
        const db = dbStats || await getDatabaseStats();
        const routeLists = core.getRouteLists();

        return {
            timestamp: Date.now(),
            cpu: cpuHistory.length > 0 ? cpuHistory[cpuHistory.length - 1].value : 0,
            memoryMB: getMemoryMB(),
            memoryPercent: getMemoryPercent(),
            heapUsedMB: heap.used,
            heapTotalMB: heap.total,
            loadAvg: getLoadAverage(),
            uptime: getSystemUptime(),
            processUptime: Math.round(process.uptime()),
            responseTime: responseTimeHistory.length > 0
                ? responseTimeHistory[responseTimeHistory.length - 1].value
                : 0,
            rps: rpsHistory.length > 0 ? rpsHistory[rpsHistory.length - 1].value : 0,
            statusCodes: { ...state.statusCodes },
            totalRequests: state.totalRequests,
            activeConnections: state.activeConnections,
            eventLoopLag: eventLoopLagHistory.length > 0
                ? eventLoopLagHistory[eventLoopLagHistory.length - 1].value
                : 0,
            hostname: getHostname(),
            platform: getPlatformLabel(),
            nodeVersion: getRuntimeVersion(),
            pid: process.pid,
            cpuCount: getCpuInfo().length,
            percentiles: calculatePercentiles(state.responseTimeSamples),
            topRoutes: routeLists.topRoutes,
            slowestRoutes: routeLists.slowestRoutes,
            errorRoutes: routeLists.errorRoutes,
            recentErrors: [...state.recentErrors],
            alerts: checkAlerts(),
            gc: {
                collections: gcCollections,
                pauseTimeMs: round(gcPauseTimeMs),
                heapGrowthRate: round(heapGrowthRate)
            },
            database: db,
            rateLimitStats: { blocked: state.rateLimitBlocked, total: state.rateLimitTotal },
            errorRate: getErrorRate()
        };
    }

    function getChartData(): ChartData {
        return {
            cpu: [...cpuHistory],
            memory: [...memoryHistory],
            heap: [...heapHistory],
            loadAvg: [...loadAvgHistory],
            responseTime: [...responseTimeHistory],
            rps: [...rpsHistory],
            eventLoopLag: [...eventLoopLagHistory],
            errorRate: [...errorRateHistory]
        };
    }

    function start(): void {
        if (!metricsInterval) {
            lastLoopTime = Date.now();
            enableInstrumentation();
            metricsInterval = setInterval(updateMetrics, config.updateInterval);
            // Don't hold the process open: a script or test that forgets stop()
            // should still exit once its own work is done.
            metricsInterval.unref?.();
            console.log('📊 Status monitor started');
        }
    }

    function stop(): void {
        if (metricsInterval) {
            clearInterval(metricsInterval);
            metricsInterval = null;
            console.log('📊 Status monitor stopped');
        }
        try { eventLoopHistogram?.disable(); } catch { /* ignore */ }
        eventLoopHistogram = null;
        try { gcObserver?.disconnect(); } catch { /* ignore */ }
        gcObserver = null;
    }

    // Clear all accumulated request/route/error counters (system gauges are live).
    function resetStats(): void {
        cpuHistory = [];
        memoryHistory = [];
        heapHistory = [];
        loadAvgHistory = [];
        responseTimeHistory = [];
        rpsHistory = [];
        eventLoopLagHistory = [];
        errorRateHistory = [];
        core.resetCounters();
        gcCollections = 0;
        gcPauseTimeMs = 0;
    }

    // initSocket is now a no-op for backwards compatibility
    function initSocket(): null {
        console.log('📊 Status monitor using polling mode (no WebSocket)');

        // Set up IPC message handler for cluster mode
        if (config.clusterMode && clusterAggregator) {
            process.on('message', (message: unknown) => {
                if (isWorkerMetricsMessage(message)) {
                    clusterAggregator.updateWorkerMetrics(message);
                }
            });
            console.log('📊 Status monitor initialized (cluster mode - aggregating workers)');
        }

        return null;
    }

    // For cluster mode aggregation
    function getAggregatedSnapshot(): Promise<MetricsSnapshot> {
        return getMetricsSnapshot().then(snapshot => {
            if (clusterAggregator && clusterAggregator.workerCount > 0) {
                return clusterAggregator.aggregateMetrics(snapshot);
            }
            return snapshot;
        });
    }

    function getAggregatedCharts(): ChartData {
        const charts = getChartData();
        if (clusterAggregator && clusterAggregator.workerCount > 0) {
            return clusterAggregator.aggregateCharts(charts);
        }
        return charts;
    }

    return {
        config,
        trackRequest: core.trackRequest,
        trackRequestComplete: core.trackRequestComplete,
        trackRateLimitEvent: core.trackRateLimitEvent,
        getMetricsSnapshot: getAggregatedSnapshot,
        getChartData: getAggregatedCharts,
        getHealthReport: core.getHealthReport,
        healthConfigured: core.healthConfigured,
        resetStats,
        start,
        stop,
        initSocket,
        formatUptime,
        get io() { return null; }
    };
}

export type Monitor = ReturnType<typeof createMonitor>;
