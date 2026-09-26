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
    DatabaseStats,
    MetricsSnapshot,
    ChartData
} from './types.js';
import {
    isClusterWorker,
    getWorkerId,
    sendMetricsToMaster,
    createClusterAggregator,
    isWorkerMetricsMessage,
    type ClusterAggregator
} from './cluster.js';
import { calculatePercentiles, defaultNormalizePath, formatUptime, latest, round } from './metrics-utils.js';
import { detectPlatform } from './platform.js';
import { createStatsCore } from './stats-core.js';
import { baseDefaults, mergeConfig, resolveLogger, validateConfig } from './config.js';

// Default configuration
const DEFAULT_CONFIG: Required<StatusMonitorConfig> = baseDefaults();

/**
 * Create a status monitor instance
 */
export function createMonitor(userConfig: StatusMonitorConfig = {}) {
    const inClusterMode = userConfig.clusterMode ?? isClusterWorker();

    const logger = resolveLogger(userConfig.logger);
    const config: Required<StatusMonitorConfig> = validateConfig(mergeConfig(DEFAULT_CONFIG, userConfig, {
        normalizePath: userConfig.normalizePath || defaultNormalizePath,
        clusterMode: inClusterMode
    }));


    const clusterAggregator: ClusterAggregator | null = inClusterMode
        ? createClusterAggregator({ maxRoutes: config.maxRoutes, retentionSeconds: config.retentionSeconds })
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
            if (!cpu || !lastCpu) continue;

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
            return round(loadAvg[0] ?? 0);
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
        const cpu = latest(cpuHistory);
        const memory = getMemoryPercent();
        const respTime = latest(responseTimeHistory);
        const errorRate = getErrorRate();
        const lag = latest(eventLoopLagHistory);

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
            cpu: latest(cpuHistory),
            memory: getMemoryPercent(),
            responseTime: latest(responseTimeHistory),
            errorRate: getErrorRate(),
            eventLoopLag: latest(eventLoopLagHistory)
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
            sendMetricsToMaster(snapshot, ...nextChartPayload());
        }
    }

    // Cluster IPC: send only chart points added since the last message, with a
    // full resend every FULL_SYNC_EVERY messages so a receiver that started
    // late (or restarted) catches up. Cuts per-tick IPC from 8 x retention
    // points to ~8 points. Deltas start only once every peer has said it
    // understands them (a 1.1.x worker would replace its charts with the
    // delta), and not before a few ticks have passed to hear from peers.
    const FULL_SYNC_EVERY = 30;
    let chartMessages = 0;
    let lastSentChartTs = -Infinity;

    function nextChartPayload(): [ChartData, boolean] {
        const charts = getChartData();
        const n = chartMessages++;
        const peerJoined = clusterAggregator?.takePeerJoined() ?? false;
        const full = n % FULL_SYNC_EVERY === 0 || n < 3 || peerJoined ||
            !(clusterAggregator?.peersAcceptDeltas(getWorkerId()) ?? true);
        const since = lastSentChartTs;
        let newest = lastSentChartTs;
        for (const series of Object.values(charts)) {
            const last = series[series.length - 1];
            if (last && last.timestamp > newest) newest = last.timestamp;
        }
        lastSentChartTs = newest;
        if (full) return [charts, false];
        const delta = {} as ChartData;
        for (const key of Object.keys(charts) as (keyof ChartData)[]) {
            delta[key] = charts[key].filter((p) => p.timestamp > since);
        }
        return [delta, true];
    }

    async function getMetricsSnapshot(dbStats?: DatabaseStats): Promise<MetricsSnapshot> {
        const heap = getHeapUsage();
        const db = dbStats || await getDatabaseStats();
        const routeLists = core.getRouteLists();

        return {
            timestamp: Date.now(),
            cpu: latest(cpuHistory),
            memoryMB: getMemoryMB(),
            memoryPercent: getMemoryPercent(),
            heapUsedMB: heap.used,
            heapTotalMB: heap.total,
            loadAvg: getLoadAverage(),
            uptime: getSystemUptime(),
            processUptime: Math.round(process.uptime()),
            responseTime: latest(responseTimeHistory),
            rps: latest(rpsHistory),
            statusCodes: { ...state.statusCodes },
            totalRequests: state.totalRequests,
            activeConnections: state.activeConnections,
            eventLoopLag: latest(eventLoopLagHistory),
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

    // Peer workers' metrics arrive over IPC (relayed by setupClusterPrimary).
    let ipcListener: ((message: unknown) => void) | null = null;
    function listenToPeers(): void {
        if (ipcListener || !config.clusterMode || !clusterAggregator) return;
        ipcListener = (message: unknown) => {
            if (isWorkerMetricsMessage(message)) clusterAggregator.updateWorkerMetrics(message);
        };
        process.on('message', ipcListener);
        logger.log('📊 Status monitor initialized (cluster mode - aggregating workers)');
    }

    function start(): void {
        listenToPeers();
        if (!metricsInterval) {
            lastLoopTime = Date.now();
            enableInstrumentation();
            metricsInterval = setInterval(updateMetrics, config.updateInterval);
            // Don't hold the process open: a script or test that forgets stop()
            // should still exit once its own work is done.
            metricsInterval.unref?.();
            logger.log('📊 Status monitor started');
        }
    }

    function stop(): void {
        if (ipcListener) {
            process.off('message', ipcListener);
            ipcListener = null;
        }
        if (metricsInterval) {
            clearInterval(metricsInterval);
            metricsInterval = null;
            logger.log('📊 Status monitor stopped');
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
        beginRequest: core.beginRequest,
        endRequest: core.endRequest,
        getHistograms: core.getHistograms,
        logger,
        trackRateLimitEvent: core.trackRateLimitEvent,
        getMetricsSnapshot: getAggregatedSnapshot,
        getChartData: getAggregatedCharts,
        getHealthReport: core.getHealthReport,
        healthConfigured: core.healthConfigured,
        resetStats,
        start,
        stop,
        formatUptime
    };
}

export type Monitor = ReturnType<typeof createMonitor>;
