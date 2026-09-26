// =============================================================================
// HONO STATUS MONITOR - STATUS FACTORY
// Shared assembly of routes, middleware and the public monitor handle.
// Node and edge differ only by the options passed in here.
// =============================================================================

import { Hono } from 'hono';
import type { MetricsSnapshot, ChartData, HealthReport, StatusMonitorConfig } from './types.js';
import { createRequestTrackingMiddleware } from './request-tracking.js';
import { createAuthGuard, registerCommonRoutes } from './routes.js';

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
    getHealthReport(): Promise<HealthReport>;
    resetStats(): void;
    start(): void;
    stop(): void;
    formatUptime(seconds: number): string;
}

export interface AssembleOptions<
    M extends AssemblableMonitor,
    I extends (server?: any) => unknown = (server?: any) => unknown
> {
    /**
     * Produce the dashboard HTML. Called per request, and awaited, so callers
     * can lazily `import()` the dashboard module instead of pulling ~27 KB of
     * markup into the entry bundle.
     */
    renderDashboard: (monitor: M, snapshot: MetricsSnapshot) => string | Promise<string>;
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

    // Dashboard page
    routes.get('/', async (c) => {
        const snapshot = await monitor.getMetricsSnapshot();
        return c.html(await options.renderDashboard(monitor, snapshot));
    });

    // JSON API endpoint
    routes.get('/api/metrics', async (c) => {
        return c.json({
            snapshot: await monitor.getMetricsSnapshot(),
            charts: monitor.getChartData()
        });
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
