// =============================================================================
// HONO STATUS MONITOR - CORE METRICS SERVICE
// Real-time server metrics collection with WebSocket broadcasting
// =============================================================================

import * as os from 'os';
import type { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import type {
    StatusMonitorConfig,
    MetricDataPoint,
    StatusCodeCount,
    RouteStats,
    ErrorEntry,
    PercentileData,
    AlertStatus,
    GCStats,
    DatabaseStats,
    MetricsSnapshot,
    ChartData
} from './types.js';

// Default configuration
const DEFAULT_CONFIG: Required<StatusMonitorConfig> = {
    path: '/status',
    title: 'Server Status',
    socketPath: '/status/socket.io',
    updateInterval: 1000,
    retentionSeconds: 60,
    maxRecentErrors: 10,
    maxRoutes: 10,
    alerts: {
        cpu: 80,
        memory: 90,
        responseTime: 500,
        errorRate: 5,
        eventLoopLag: 100
    },
    healthCheck: async () => ({ connected: true, latencyMs: 0 }),
    normalizePath: (path: string) => path
};

/**
 * Default path normalization function
 * Groups similar routes together for analytics
 */
function defaultNormalizePath(path: string): string {
    return path
        // Replace UUIDs
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':uuid')
        // Replace MongoDB ObjectIds (24 hex characters)
        .replace(/[0-9a-f]{24}/gi, ':id')
        // Replace numeric IDs
        .replace(/\/\d+/g, '/:id')
        // Limit path depth to prevent explosion
        .split('/').slice(0, 4).join('/');
}

/**
 * Create a status monitor instance
 */
export function createMonitor(userConfig: StatusMonitorConfig = {}) {
    // Merge configuration
    const config: Required<StatusMonitorConfig> = {
        ...DEFAULT_CONFIG,
        ...userConfig,
        alerts: { ...DEFAULT_CONFIG.alerts, ...userConfig.alerts },
        normalizePath: userConfig.normalizePath || defaultNormalizePath
    };

    // In-memory metrics storage
    let cpuHistory: MetricDataPoint[] = [];
    let memoryHistory: MetricDataPoint[] = [];
    let heapHistory: MetricDataPoint[] = [];
    let loadAvgHistory: MetricDataPoint[] = [];
    let responseTimeHistory: MetricDataPoint[] = [];
    let rpsHistory: MetricDataPoint[] = [];
    let eventLoopLagHistory: MetricDataPoint[] = [];
    let errorRateHistory: MetricDataPoint[] = [];

    // Request tracking
    let requestCount = 0;
    let lastRequestCount = 0;
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

    // GC tracking
    let lastHeapUsed = 0;
    let heapGrowthRate = 0;

    // CPU tracking
    let lastCpuInfo: os.CpuInfo[] | null = null;

    // Event loop lag tracking
    let lastLoopTime = Date.now();

    // Database latency tracking
    let dbLatency = 0;

    // WebSocket server reference
    let io: SocketServer | null = null;

    // Metrics collection interval
    let metricsInterval: ReturnType<typeof setInterval> | null = null;

    /**
     * Calculate CPU usage percentage
     */
    function calculateCpuUsage(): number {
        const cpus = os.cpus();

        if (!lastCpuInfo) {
            lastCpuInfo = cpus;
            return 0;
        }

        let totalIdle = 0;
        let totalTick = 0;

        for (let i = 0; i < cpus.length; i++) {
            const cpu = cpus[i];
            const lastCpu = lastCpuInfo[i];

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
        return Math.round(((totalTick - totalIdle) / totalTick) * 1000) / 10;
    }

    /**
     * Get memory usage in MB
     */
    function getMemoryMB(): number {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        return Math.round((usedMem / (1024 * 1024)) * 10) / 10;
    }

    /**
     * Get memory usage percentage
     */
    function getMemoryPercent(): number {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        return Math.round((usedMem / totalMem) * 1000) / 10;
    }

    /**
     * Get heap memory usage and track growth
     */
    function getHeapUsage(): { used: number; total: number } {
        const mem = process.memoryUsage();
        const used = Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10;

        // Track heap growth
        if (lastHeapUsed > 0) {
            heapGrowthRate = used - lastHeapUsed;
        }
        lastHeapUsed = used;

        return {
            used,
            total: Math.round((mem.heapTotal / (1024 * 1024)) * 10) / 10
        };
    }

    /**
     * Get 1-minute load average
     */
    function getLoadAverage(): number {
        const loadAvg = os.loadavg();
        return Math.round(loadAvg[0] * 100) / 100;
    }

    /**
     * Measure event loop lag
     */
    function measureEventLoopLag(): number {
        const now = Date.now();
        const expectedInterval = config.updateInterval;
        const actualInterval = now - lastLoopTime;
        lastLoopTime = now;

        const lag = Math.max(0, actualInterval - expectedInterval);
        return Math.round(lag * 10) / 10;
    }

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
     * Check alert conditions
     */
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

    /**
     * Get database stats using custom health check
     */
    async function getDatabaseStats(): Promise<DatabaseStats> {
        try {
            const start = performance.now();
            const result = await config.healthCheck();
            dbLatency = Math.round((performance.now() - start) * 100) / 100;

            return {
                connected: result.connected,
                poolSize: 10,
                availableConnections: result.connected ? 10 : 0,
                waitQueueSize: 0,
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
     * Update metrics and broadcast via WebSocket
     */
    async function updateMetrics(): Promise<void> {
        const heap = getHeapUsage();
        const eventLoopLag = measureEventLoopLag();
        const errorRate = getErrorRate();

        // System metrics
        addToHistory(cpuHistory, calculateCpuUsage());
        addToHistory(memoryHistory, getMemoryMB());
        addToHistory(heapHistory, heap.used);
        addToHistory(loadAvgHistory, getLoadAverage());
        addToHistory(eventLoopLagHistory, eventLoopLag);
        addToHistory(errorRateHistory, errorRate);

        // Request metrics
        const currentRps = requestCount - lastRequestCount;
        lastRequestCount = requestCount;
        addToHistory(rpsHistory, currentRps);

        // Average response time
        const avgResponseTime = responseTimeCount > 0
            ? Math.round((totalResponseTime / responseTimeCount) * 100) / 100
            : 0;
        addToHistory(responseTimeHistory, avgResponseTime);

        // Reset response time tracking
        totalResponseTime = 0;
        responseTimeCount = 0;

        // Trim response time samples (keep last 1000)
        if (responseTimeSamples.length > 1000) {
            responseTimeSamples = responseTimeSamples.slice(-500);
        }

        // Broadcast to connected clients
        if (io) {
            const dbStats = await getDatabaseStats();
            io.emit('metrics', {
                snapshot: await getMetricsSnapshot(dbStats),
                charts: getChartData()
            });
        }
    }

    /**
     * Get current metrics snapshot
     */
    async function getMetricsSnapshot(dbStats?: DatabaseStats): Promise<MetricsSnapshot> {
        const heap = getHeapUsage();
        const db = dbStats || await getDatabaseStats();

        return {
            timestamp: Date.now(),
            cpu: cpuHistory.length > 0 ? cpuHistory[cpuHistory.length - 1].value : 0,
            memoryMB: getMemoryMB(),
            memoryPercent: getMemoryPercent(),
            heapUsedMB: heap.used,
            heapTotalMB: heap.total,
            loadAvg: getLoadAverage(),
            uptime: Math.round(os.uptime()),
            processUptime: Math.round(process.uptime()),
            responseTime: responseTimeHistory.length > 0
                ? responseTimeHistory[responseTimeHistory.length - 1].value
                : 0,
            rps: rpsHistory.length > 0
                ? rpsHistory[rpsHistory.length - 1].value
                : 0,
            statusCodes: { ...statusCodes },
            totalRequests,
            activeConnections,
            eventLoopLag: eventLoopLagHistory.length > 0
                ? eventLoopLagHistory[eventLoopLagHistory.length - 1].value
                : 0,
            hostname: os.hostname(),
            platform: `${os.type()} ${os.release()}`,
            nodeVersion: process.version,
            pid: process.pid,
            cpuCount: os.cpus().length,
            percentiles: calculatePercentiles(),
            topRoutes: getTopRoutes(),
            slowestRoutes: getSlowestRoutes(),
            errorRoutes: getErrorRoutes(),
            recentErrors: [...recentErrors],
            alerts: checkAlerts(),
            gc: {
                collections: 0,
                pauseTimeMs: 0,
                heapGrowthRate: Math.round(heapGrowthRate * 100) / 100
            },
            database: db,
            rateLimitStats: { blocked: rateLimitBlocked, total: rateLimitTotal },
            errorRate: getErrorRate()
        };
    }

    /**
     * Get chart data
     */
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

                // Add to recent errors
                recentErrors.unshift({
                    timestamp: Date.now(),
                    path: normalizedPath,
                    method,
                    status: statusCode,
                    message: `${method} ${normalizedPath} returned ${statusCode}`
                });

                // Keep only recent errors
                while (recentErrors.length > config.maxRecentErrors) {
                    recentErrors.pop();
                }
            }
        }
    }

    /**
     * Track rate limit
     */
    function trackRateLimitEvent(blocked: boolean): void {
        rateLimitTotal++;
        if (blocked) rateLimitBlocked++;
    }

    /**
     * Start metrics collection
     */
    function start(): void {
        if (!metricsInterval) {
            lastLoopTime = Date.now();
            metricsInterval = setInterval(updateMetrics, config.updateInterval);
            console.log('📊 Status monitor started');
        }
    }

    /**
     * Stop metrics collection
     */
    function stop(): void {
        if (metricsInterval) {
            clearInterval(metricsInterval);
            metricsInterval = null;
            console.log('📊 Status monitor stopped');
        }
    }

    /**
     * Initialize Socket.io server
     */
    function initSocket(server: HttpServer): SocketServer {
        io = new SocketServer(server, {
            path: config.socketPath,
            cors: {
                origin: '*',
                methods: ['GET', 'POST']
            }
        });

        io.on('connection', (socket) => {
            console.log('📊 Status monitor client connected');
            socket.on('disconnect', () => {
                console.log('📊 Status monitor client disconnected');
            });
        });

        console.log('📊 Status monitor WebSocket initialized');
        return io;
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
        get io() { return io; }
    };
}

export type Monitor = ReturnType<typeof createMonitor>;
