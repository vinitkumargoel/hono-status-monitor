// =============================================================================
// HONO STATUS MONITOR - STATUS FACTORY
// Shared assembly of routes, middleware and the public monitor handle.
// Node and edge differ only by the options passed in here.
// =============================================================================

import { Hono } from 'hono';
import type { MetricsSnapshot, ChartData, HealthReport, StatusMonitorConfig } from './types.js';
import { createRequestTrackingMiddleware } from './request-tracking.js';
import { createAuthGuard, registerCommonRoutes, NO_STORE } from './routes.js';
import { BASELINE_HEADERS, dashboardSecurityHeaders, generateNonce } from './security.js';
import { DEFAULT_ADAPTER_URL, DEFAULT_CHARTJS_URL } from './chart-cdn.js';

/**
 * The surface a monitor must expose to be assembled into a status monitor.
 * Both `createMonitor` (Node) and `createEdgeMonitor` satisfy this.
 */
export interface AssemblableMonitor {
    config: Required<StatusMonitorConfig>;
    trackRequest(path: string, method: string): void;
    trackRequestComplete(path: string, method: string, durationMs: number, statusCode: number): void;
    trackRateLimitEvent(blocked: boolean): void;
    getMetricsSnapshot(): Promise<MetricsSnapshot>;
    getChartData(): ChartData;
    getHealthReport(maxAgeMs?: number): Promise<HealthReport>;
    /** Whether any health check was configured (vs. the built-in placeholder). */
    healthConfigured: boolean;
    resetStats(): void;
    start(): void;
    stop(): void;
    formatUptime(seconds: number): string;
}

/** Minimum age of the health data sent with dashboard polls. */
const DASHBOARD_HEALTH_MAX_AGE_MS = 5000;

export interface AssembleOptions<
    M extends AssemblableMonitor,
    I extends (server?: any) => unknown = (server?: any) => unknown
> {
    /**
     * Produce the dashboard HTML. Called per request, and awaited, so callers
     * can lazily `import()` the dashboard module instead of pulling ~27 KB of
     * markup into the entry bundle.
     */
    renderDashboard: (
        monitor: M,
        snapshot: MetricsSnapshot,
        extras: { nonce: string }
    ) => string | Promise<string>;
    /** Register the SSE `/api/stream` route. Off on edge isolates. */
    enableStream: boolean;
    /** Reported on the returned handle and used by consumers to branch. */
    isEdgeMode: boolean;
    /**
     * Backwards-compatible socket initializer. The argument is accepted and
     * ignored — kept so existing `monitor.initSocket(server)` calls still type.
     * Generic so each caller's exact signature/return type reaches the handle.
     */
    initSocket: I;
    /** CSP nonce source; defaults to Web Crypto. */
    generateNonce?: () => string;
}

/**
 * Wire a monitor into Hono routes + middleware and return the public handle.
 *
 * Route surface: `GET /` (dashboard), `GET /api/metrics`, plus `/health`,
 * `/prometheus` and optionally `/api/stream` via `registerCommonRoutes`.
 */
export function assembleStatusMonitor<
    M extends AssemblableMonitor,
    I extends (server?: any) => unknown
>(
    monitor: M,
    options: AssembleOptions<M, I>
) {
    const middleware = createRequestTrackingMiddleware(monitor);
    const routes = new Hono();

    // Optional auth guard for the whole status surface.
    const guard = createAuthGuard(monitor.config.authorize);
    if (guard) routes.use('*', guard);

    // Script origins the dashboard may load, for the CSP.
    const cfg = monitor.config;
    const scriptUrls = cfg.inlineCharts
        ? []
        : [cfg.chartjsUrl ?? DEFAULT_CHARTJS_URL, cfg.chartAdapterUrl ?? DEFAULT_ADAPTER_URL];

    const makeNonce = options.generateNonce ?? generateNonce;

    // Dashboard page
    routes.get('/', async (c) => {
        const snapshot = await monitor.getMetricsSnapshot();
        const nonce = makeNonce();
        const html = await options.renderDashboard(monitor, snapshot, { nonce });
        const headers = cfg.securityHeaders
            ? dashboardSecurityHeaders(nonce, scriptUrls, c.req.url)
            : BASELINE_HEADERS;
        return c.html(html, 200, { ...headers });
    });

    // Dashboard polls read health through a longer-lived cache than /health,
    // so an open dashboard adds at most one round of checks per window.
    const dashboardHealthAge = Math.max(DASHBOARD_HEALTH_MAX_AGE_MS, cfg.pollingInterval);

    // JSON API endpoint. `health` is only included when checks are configured,
    // so a monitor without checks does no extra work per poll.
    routes.get('/api/metrics', async (c) => {
        const [snapshot, health] = await Promise.all([
            monitor.getMetricsSnapshot(),
            monitor.healthConfigured ? monitor.getHealthReport(dashboardHealthAge) : undefined
        ]);
        return c.json({ snapshot, charts: monitor.getChartData(), health }, 200, NO_STORE);
    });

    // /health, /prometheus and (optionally) /api/stream
    registerCommonRoutes(routes, monitor, { enableStream: options.enableStream });

    // Start metrics collection. Note this is a construction-time side effect: on
    // Node it registers an interval that keeps the process alive until stop().
    monitor.start();

    return {
        /** Hono middleware for tracking all requests */
        middleware,
        /** Pre-configured Hono routes for dashboard and API */
        routes,
        /** Initialize server transport (no-op on edge; kept for compatibility) */
        initSocket: options.initSocket,
        /** Track rate limit events for the dashboard */
        trackRateLimit: (blocked: boolean) => monitor.trackRateLimitEvent(blocked),
        /** Get current metrics snapshot */
        getMetrics: () => monitor.getMetricsSnapshot(),
        /** Get chart data for all metrics */
        getCharts: () => monitor.getChartData(),
        /** Get the aggregated health report (same payload as GET /health) */
        getHealth: () => monitor.getHealthReport(),
        /** Reset all accumulated request/route/error counters */
        resetStats: () => monitor.resetStats(),
        /** Stop metrics collection */
        stop: () => monitor.stop(),
        /** Access to the underlying monitor instance */
        monitor,
        /** Whether running in edge mode */
        isEdgeMode: options.isEdgeMode
    };
}
