// =============================================================================
// HONO STATUS MONITOR - TYPE DEFINITIONS
// =============================================================================

import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { CounterMetric, GaugeMetric } from './custom-metrics.js';

/**
 * Configuration options for the status monitor
 */
export interface StatusMonitorConfig {
    /** Path where the dashboard will be mounted (default: '/status') */
    path?: string;
    /** Dashboard title (default: 'Server Status') */
    title?: string;
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
     * Each is run in parallel; the endpoint returns 503 if any required check
     * fails. A check is either a function or `{ check, required, timeoutMs }`;
     * a check with `required: false` is reported but never degrades `/health`.
     */
    healthChecks?: Record<string, HealthCheckFn | HealthCheckDefinition>;
    /**
     * Give up on a health check after this many milliseconds and report it as
     * disconnected, so one hung dependency can't stall `/health` or the
     * dashboard. `0` disables the timeout (default: 5000).
     */
    healthCheckTimeout?: number;
    /** Custom path normalization function */
    normalizePath?: (path: string) => string;
    /**
     * How requests are grouped into routes:
     * - `'path'` (default): the request path, through `normalizePath`.
     * - `'route'`: the Hono route pattern that handled the request
     *   (`/users/:id`), so parameterised routes group exactly regardless of
     *   depth. Requests no route matched fall back to `normalizePath`.
     */
    groupBy?: 'path' | 'route';
    /**
     * Requests to leave out of the metrics entirely, e.g. favicon, asset or
     * probe traffic. Strings match a path exactly or as a prefix when they end
     * in `/*`; RegExps are tested against the path; or pass a predicate.
     * The monitor's own mount path is always excluded.
     */
    ignorePaths?: Array<string | RegExp> | ((path: string) => boolean);
    /**
     * Fraction of requests (0–1) recorded in per-route stats, latency
     * percentiles and histograms (default: 1). The totals — request count,
     * status codes and the overall error rate — always include every request;
     * per-route counts and errors cover only the sampled share.
     */
    sampleRate?: number;
    /**
     * Where the monitor writes its own messages (start/stop, warnings).
     * Pass `false` to silence it (default: `console`).
     */
    logger?: StatusLogger | false;
    /**
     * Maximum concurrent `/api/stream` connections per monitor; extra clients
     * get a 503 and the dashboard falls back to polling (default: 100).
     */
    maxStreamClients?: number;
    /** Enable cluster mode for PM2/multi-process aggregation (auto-detected if not set) */
    clusterMode?: boolean;
    /**
     * Guard the dashboard, API, stream, health and Prometheus endpoints.
     * Return `true`/`false` (or a Promise of it) from the Hono context; falsy
     * responses get a 401. Either this or `publicAccess: true` is required for
     * the status routes to answer at all.
     */
    authorize?: (c: Context) => boolean | Promise<boolean>;
    /**
     * Serve the status routes without `authorize`. Without either, every status
     * route answers 403 with a message saying how to enable it, so the
     * dashboard is never public by accident. A common development setting is
     * `publicAccess: process.env.NODE_ENV !== 'production'` (default: false).
     */
    publicAccess?: boolean;
    /** Called whenever an alert transitions between OK and breached. */
    onAlert?: (event: AlertEvent) => void;
    /** Expose a Prometheus/OpenMetrics scrape endpoint at `<path>/prometheus` (default: true) */
    prometheus?: boolean;
    /** Metric name prefix used in Prometheus output (default: 'hono') */
    prometheusPrefix?: string;
    /**
     * Add a `<prefix>_http_request_duration_seconds` histogram labelled by
     * method, route and status to `/prometheus`. Off by default because it adds
     * up to ~14 series per route and status; pair it with `groupBy: 'route'`
     * to keep the `route` label bounded (default: false).
     */
    prometheusHistogram?: boolean;
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
     * Send a nonce-based Content-Security-Policy with the dashboard (scripts
     * limited to its own inline script and the configured Chart.js origin) and
     * restrict framing to the same origin (`frame-ancestors 'self'`,
     * `X-Frame-Options: SAMEORIGIN`). Set to false if the dashboard must be
     * embedded cross-origin or a proxy injects scripts into it.
     * `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
     * `Cache-Control: no-store` are always sent (default: true).
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
    /**
     * Upper bound on peer snapshots read from `store` per refresh, so a large
     * fleet doesn't turn each dashboard read into hundreds of KV reads.
     * Default: 50.
     */
    maxPeers?: number;
}

/** A health check function. */
export type HealthCheckFn = () => Promise<HealthCheckResult>;

/** A health check with options. */
export interface HealthCheckDefinition {
    check: HealthCheckFn;
    /** When false, a failure is reported but doesn't make `/health` 503 (default: true). */
    required?: boolean;
    /** Per-check timeout in ms; overrides `healthCheckTimeout`. */
    timeoutMs?: number;
}

/**
 * What the monitor writes through: `console`, pino, winston and most other
 * loggers fit. `warn` and `error` are required; informational messages go to
 * `log`, else `info`, else nowhere.
 */
export interface StatusLogger {
    log?(...args: unknown[]): void;
    info?(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

/**
 * Minimal key-value store contract compatible with Cloudflare KV and easy to
 * back with a Durable Object or any custom store. Used for edge aggregation.
 */
export interface StatusStore {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
    /**
     * Optional: keys and values under a prefix in one call. When present the
     * monitor uses it to load peers instead of `list` plus one `get` per peer
     * (the Durable Object store implements it).
     */
    entries?(options?: { prefix?: string }): Promise<{ name: string; value: string }[]>;
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
    /** False for checks configured with `required: false`. */
    required?: boolean;
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
    /**
     * When true, `charts` holds only points newer than the previous message and
     * is appended to what the receiver already has. Full messages are sent
     * periodically so a newly started receiver catches up.
     */
    delta?: boolean;
    /**
     * Set by senders that understand `delta` (1.2+). Workers only send deltas
     * once every peer has advertised this, so a 1.1.x worker in a mixed fleet
     * (rolling restart) keeps receiving full charts it can replace wholesale.
     */
    deltaCapable?: boolean;
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
    /** Use the SSE stream for live updates, falling back to polling. */
    stream?: boolean;
    /** Rows shown in each route list (default 5). */
    maxRoutes?: number;
    /** Rows shown in the recent errors panel (default 5). */
    maxRecentErrors?: number;
    /** History kept server-side; enables the chart range selector above 60 s. */
    retentionSeconds?: number;
}

/**
 * The handle returned by `statusMonitor()`.
 *
 * Mount `middleware` on the requests you want measured and `routes` under
 * `config.path`. Collection starts on the first request (or `start()`).
 *
 * @typeParam M - The underlying monitor (`Monitor` on Node/Bun/Deno,
 *   `EdgeMonitor` on edge runtimes).
 * @typeParam E - Literal type of `isEdgeMode`, so that checking it narrows
 *   `monitor` when the handle is a union (as the main entry returns).
 */
export interface StatusMonitor<M = unknown, E extends boolean = boolean> {
    /** Hono middleware that records every request it sees (except the status routes). */
    middleware: MiddlewareHandler;
    /** Dashboard, `/api/metrics`, `/api/stream`, `/health` and `/prometheus`; mount at `config.path`. */
    routes: Hono;
    /**
     * Start collecting now. Otherwise collection starts on the first request
     * through `middleware`, the first authorized status-route hit, or the first
     * `getMetrics`/`getCharts`/`getHealth` call. Idempotent.
     */
    start(): void;
    /** Stop collecting (timers, IPC listener). Stays stopped until `start()`. */
    stop(): void;
    /** Current metrics snapshot (fleet- or cluster-aggregated when configured). */
    getMetrics(): Promise<MetricsSnapshot>;
    /** Chart series for the retention window. */
    getCharts(): ChartData;
    /** Aggregated health report — the same payload as `GET /health`. */
    getHealth(): Promise<HealthReport>;
    /** Count a rate-limit decision for the dashboard. */
    trackRateLimit(blocked: boolean): void;
    /** Reset request, route and error counters (system gauges are live). */
    resetStats(): void;
    /**
     * Register (or get) an application counter, exported as
     * `<prometheusPrefix>_<name>` on `/prometheus` and under `custom` in
     * `/api/metrics`. Per instance; not merged across workers or isolates.
     *
     * @example
     * const orders = monitor.counter('orders_total', 'Orders placed');
     * orders.inc({ plan: 'pro' });
     */
    counter(name: string, help?: string): CounterMetric;
    /** Register (or get) an application gauge. See {@link StatusMonitor.counter}. */
    gauge(name: string, help?: string): GaugeMetric;
    /** The underlying monitor instance. */
    monitor: M;
    /** Whether the request-only edge monitor is in use. Narrows `monitor`. */
    isEdgeMode: E;
}
