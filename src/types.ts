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
    /**
     * @deprecated Unused since the switch to polling; accepted and ignored so
     * existing configs keep compiling. Will be removed in 2.0.
     */
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
    /**
     * Hard cap on distinct routes tracked in memory. Prevents unbounded growth
     * from scanners/unique-path attacks. Least-recently-used routes are evicted
     * once the cap is reached (default: 1000).
     */
    maxTrackedRoutes?: number;
    /** Alert thresholds */
    alerts?: AlertThresholds;
    /** Optional async function to check database health (single-check shorthand) */
    healthCheck?: () => Promise<HealthCheckResult>;
    /**
     * Named health checks surfaced on the dashboard and `/health` endpoint.
     * Each is run in parallel; the endpoint returns 503 if any required check fails.
     */
    healthChecks?: Record<string, () => Promise<HealthCheckResult>>;
    /**
     * Give up on a health check after this many milliseconds and report it as
     * disconnected, so one hung dependency can't stall `/health` or the
     * dashboard (default: 5000).
     */
    healthCheckTimeout?: number;
    /** Custom path normalization function */
    normalizePath?: (path: string) => string;
    /** Enable cluster mode for PM2/multi-process aggregation (auto-detected if not set) */
    clusterMode?: boolean;
    /**
     * Guard the dashboard, API and stream endpoints. Return `true`/`false`
     * (or a Promise of it) from the Hono context. Falsy responses get a 401.
     */
    authorize?: (c: any) => boolean | Promise<boolean>;
    /** Called whenever an alert transitions between OK and breached. */
    onAlert?: (event: AlertEvent) => void;
    /** Expose a Prometheus/OpenMetrics scrape endpoint at `<path>/prometheus` (default: true) */
    prometheus?: boolean;
    /** Metric name prefix used in Prometheus output (default: 'hono') */
    prometheusPrefix?: string;
    /** Override the Chart.js script URL (e.g. to self-host under a strict CSP) */
    chartjsUrl?: string;
    /** Override the Chart.js date adapter script URL */
    chartAdapterUrl?: string;
    /**
     * Render charts with a built-in, dependency-free inline SVG renderer instead
     * of loading Chart.js from a CDN. Works fully offline and under a strict CSP
     * (no external scripts). Default: false.
     */
    inlineCharts?: boolean;
    /**
     * Send hardening headers with the dashboard: a nonce-based
     * Content-Security-Policy (scripts limited to the dashboard's own inline
     * script and the configured Chart.js origin), `frame-ancestors 'self'`,
     * `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
     * Set to `false` if you embed the dashboard in a cross-origin iframe or
     * apply your own policy (default: true).
     */
    securityHeaders?: boolean;
    /**
     * Optional key-value store (Cloudflare KV / Durable Object stub / any object
     * implementing {@link StatusStore}) used on edge to aggregate request metrics
     * across isolates, which otherwise each hold their own counters. No-op on Node.
     */
    store?: StatusStore;
    /** Stable id for this instance/isolate when using `store` (default: random). */
    instanceId?: string;
    /**
     * How often (ms) to persist this instance's metrics to `store`. Kept high to
     * respect KV write limits. Default: 60000.
     */
    storeWriteInterval?: number;
}

/**
 * Minimal key-value store contract compatible with Cloudflare KV and easy to
 * back with a Durable Object or any custom store. Used for edge aggregation.
 */
export interface StatusStore {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
}

/**
 * Emitted through `onAlert` when a threshold crosses in either direction.
 */
export interface AlertEvent {
    /** Which metric changed state */
    metric: keyof AlertStatus;
    /** true = now breaching threshold, false = recovered */
    active: boolean;
    /** The measured value at transition time */
    value: number;
    /** The configured threshold for this metric */
    threshold: number;
    timestamp: number;
}

/**
 * A single named health check result, as surfaced by `/health`.
 */
export interface NamedHealthResult extends HealthCheckResult {
    name: string;
}

/**
 * Aggregated health report returned by the `/health` endpoint.
 */
export interface HealthReport {
    status: 'ok' | 'degraded';
    /**
     * False when no `healthCheck`/`healthChecks` was configured, in which case
     * `checks` holds only the built-in always-healthy placeholder.
     */
    configured?: boolean;
    uptime: number;
    timestamp: number;
    checks: NamedHealthResult[];
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
    /** Number of edge isolates aggregated (when using a store) */
    instanceCount?: number;
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
    /** @deprecated Ignored; will be removed in 2.0. */
    socketPath?: string;
    title: string;
    pollingInterval?: number;
    /** Override the Chart.js script URL */
    chartjsUrl?: string;
    /** Override the Chart.js date adapter script URL */
    chartAdapterUrl?: string;
    /** Use the built-in dependency-free inline SVG chart renderer */
    inlineCharts?: boolean;
    /** CSP nonce stamped on the inline client script (set by the route handler) */
    nonce?: string;
}

/**
 * Status monitor instance
 */
export interface StatusMonitor {
    /** Hono middleware for tracking requests */
    middleware: (c: any, next: () => Promise<void>) => Promise<void>;
    /** Pre-configured Hono routes (dashboard, API, health, prometheus, stream) */
    routes: unknown;
    /** Initialize server (returns null, kept for backwards compatibility) */
    initSocket: (server?: any) => null;
    /** Get current metrics snapshot */
    getMetrics: () => Promise<MetricsSnapshot>;
    /** Get chart data */
    getCharts: () => ChartData;
    /** Get the aggregated health report (same payload as GET /health) */
    getHealth: () => Promise<HealthReport>;
    /** Track a rate limit event */
    trackRateLimit: (blocked: boolean) => void;
    /** Reset all accumulated request/route/error counters */
    resetStats: () => void;
    /** Stop metrics collection */
    stop: () => void;
    /** Whether running in edge mode */
    isEdgeMode: boolean;
}
