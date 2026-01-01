// =============================================================================
// HONO STATUS MONITOR - TYPE DEFINITIONS
// =============================================================================

/**
 * Configuration options for the status monitor
 */
export interface StatusMonitorConfig {
    /** Path where the dashboard will be mounted (default: '/status') */
    path?: string;
    /** Dashboard title (default: 'Server Status') */
    title?: string;
    /** Socket.io path - kept for backwards compatibility (default: '/status/socket.io') */
    socketPath?: string;
    /** Dashboard polling interval in milliseconds (default: 1000 for Node.js, 5000 for edge) */
    pollingInterval?: number;
    /** Metrics collection interval in milliseconds (default: 1000) */
    updateInterval?: number;
    /** History retention in seconds (default: 60) */
    retentionSeconds?: number;
    /** Maximum recent errors to store (default: 10) */
    maxRecentErrors?: number;
    /** Maximum routes to show in analytics (default: 10) */
    maxRoutes?: number;
    /** Alert thresholds */
    alerts?: AlertThresholds;
    /** Optional async function to check database health */
    healthCheck?: () => Promise<HealthCheckResult>;
    /** Custom path normalization function */
    normalizePath?: (path: string) => string;
    /** Enable cluster mode for PM2/multi-process aggregation (auto-detected if not set) */
    clusterMode?: boolean;
}

/**
 * Alert thresholds configuration
 */
export interface AlertThresholds {
    /** CPU percentage threshold (default: 80) */
    cpu?: number;
    /** Memory percentage threshold (default: 90) */
    memory?: number;
    /** Response time in ms threshold (default: 500) */
    responseTime?: number;
    /** Error rate percentage threshold (default: 5) */
    errorRate?: number;
    /** Event loop lag in ms threshold (default: 100) */
    eventLoopLag?: number;
}

/**
 * Health check result from custom health check function
 */
export interface HealthCheckResult {
    connected: boolean;
    latencyMs: number;
    name?: string;
    details?: Record<string, unknown>;
}

/**
 * Single metric data point
 */
export interface MetricDataPoint {
    timestamp: number;
    value: number;
}

/**
 * Status code counts
 */
export interface StatusCodeCount {
    [code: string]: number;
}

/**
 * Route statistics
 */
export interface RouteStats {
    path: string;
    method: string;
    count: number;
    totalTime: number;
    avgTime: number;
    minTime: number;
    maxTime: number;
    errors: number;
    lastAccess: number;
}

/**
 * Error entry
 */
export interface ErrorEntry {
    timestamp: number;
    path: string;
    method: string;
    status: number;
    message: string;
}

/**
 * Response time percentiles
 */
export interface PercentileData {
    p50: number;
    p95: number;
    p99: number;
    avg: number;
}

/**
 * Alert status flags
 */
export interface AlertStatus {
    cpu: boolean;
    memory: boolean;
    responseTime: boolean;
    errorRate: boolean;
    eventLoopLag: boolean;
}

/**
 * GC statistics
 */
export interface GCStats {
    collections: number;
    pauseTimeMs: number;
    heapGrowthRate: number;
}

/**
 * Database/Health check stats
 */
export interface DatabaseStats {
    connected: boolean;
    poolSize: number;
    availableConnections: number;
    waitQueueSize: number;
    latencyMs: number;
    name?: string;
}

/**
 * Full metrics snapshot
 */
export interface MetricsSnapshot {
    timestamp: number;
    cpu: number;
    memoryMB: number;
    memoryPercent: number;
    heapUsedMB: number;
    heapTotalMB: number;
    loadAvg: number;
    uptime: number;
    processUptime: number;
    responseTime: number;
    rps: number;
    statusCodes: StatusCodeCount;
    totalRequests: number;
    activeConnections: number;
    eventLoopLag: number;
    hostname: string;
    platform: string;
    nodeVersion: string;
    pid: number;
    cpuCount: number;
    percentiles: PercentileData;
    topRoutes: RouteStats[];
    slowestRoutes: RouteStats[];
    errorRoutes: RouteStats[];
    recentErrors: ErrorEntry[];
    alerts: AlertStatus;
    gc: GCStats;
    database: DatabaseStats;
    rateLimitStats: { blocked: number; total: number };
    errorRate: number;
    /** Worker info for cluster mode */
    workers?: WorkerInfo[];
    /** Number of workers in cluster mode */
    workerCount?: number;
    /** Whether running in edge mode with limited metrics */
    isEdgeMode?: boolean;
}

/**
 * Worker info for cluster mode
 */
export interface WorkerInfo {
    pid: number;
    cpu: number;
    memoryMB: number;
    rps: number;
    totalRequests: number;
    responseTime: number;
}

/**
 * IPC message from worker to master
 */
export interface WorkerMetricsMessage {
    type: 'worker-metrics';
    workerId: number;
    pid: number;
    metrics: Partial<MetricsSnapshot>;
    charts: ChartData;
}

/**
 * Chart data for all metrics
 */
export interface ChartData {
    cpu: MetricDataPoint[];
    memory: MetricDataPoint[];
    heap: MetricDataPoint[];
    loadAvg: MetricDataPoint[];
    responseTime: MetricDataPoint[];
    rps: MetricDataPoint[];
    eventLoopLag: MetricDataPoint[];
    errorRate: MetricDataPoint[];
}

/**
 * Dashboard props
 */
export interface DashboardProps {
    hostname: string;
    uptime: string;
    socketPath: string;
    title: string;
    pollingInterval?: number;
}

/**
 * Status monitor instance
 */
export interface StatusMonitor {
    /** Hono middleware for tracking requests */
    middleware: (c: any, next: () => Promise<void>) => Promise<void>;
    /** Initialize server (returns null, kept for backwards compatibility) */
    initSocket: (server: any) => null;
    /** Get current metrics snapshot */
    getMetrics: () => Promise<MetricsSnapshot>;
    /** Get chart data */
    getCharts: () => ChartData;
    /** Start metrics collection */
    start: () => void;
    /** Stop metrics collection */
    stop: () => void;
    /** Track a rate limit event */
    trackRateLimit: (blocked: boolean) => void;
    /** Get dashboard HTML */
    getDashboard: () => Promise<string>;
    /** Configuration */
    config: Required<StatusMonitorConfig>;
}
