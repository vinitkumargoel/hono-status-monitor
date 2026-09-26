// =============================================================================
// HONO STATUS MONITOR - STATUS FACTORY
// Shared assembly of routes, middleware and the public monitor handle.
// Node and edge differ only by the options passed in here.
// =============================================================================

import { Hono } from 'hono';
import type { MetricsSnapshot, ChartData, HealthReport, StatusMonitor, StatusMonitorConfig } from './types.js';
import { createRequestTrackingMiddleware } from './request-tracking.js';
import { ACCESS_NOT_CONFIGURED, createAuthGuard, registerCommonRoutes, NO_STORE } from './routes.js';
import { BASELINE_HEADERS, dashboardSecurityHeaders, generateNonce } from './security.js';
import { DEFAULT_ADAPTER_URL, DEFAULT_CHARTJS_URL } from './chart-cdn.js';
import { createMetricRegistry } from './custom-metrics.js';

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
    logger?: { warn(...args: unknown[]): void };
    resetStats(): void;
    start(): void;
    stop(): void;
    formatUptime(seconds: number): string;
}

/** Minimum age of the health data sent with dashboard polls. */
const DASHBOARD_HEALTH_MAX_AGE_MS = 5000;

export interface AssembleOptions<M extends AssemblableMonitor> {
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
}

/**
 * Wire a monitor into Hono routes + middleware and return the public handle.
 *
 * Route surface: `GET /` (dashboard), `GET /api/metrics`, plus `/health`,
 * `/prometheus` and optionally `/api/stream` via `registerCommonRoutes`.
 */
export function assembleStatusMonitor<M extends AssemblableMonitor>(
    monitor: M,
    options: AssembleOptions<M>
): StatusMonitor<M> {
    // Collection starts on the first tracked request or status-route hit (or
    // an explicit start()), not at construction, so creating a monitor has no
    // side effects. stop() is final until start() is called again.
    let state: 'idle' | 'running' | 'stopped' = 'idle';
    const ensureStarted = () => {
        if (state !== 'idle') return;
        state = 'running';
        monitor.start();
    };

    const metrics = createMetricRegistry((m) => monitor.logger?.warn(m));
    const middleware = createRequestTrackingMiddleware({ ...monitor, start: ensureStarted });
    const routes = new Hono();

    // The status surface is closed unless `authorize` or `publicAccess` is set.
    const guard = createAuthGuard(monitor.config.authorize, monitor.config.publicAccess);
    if (guard) routes.use('*', guard);
    // After the guard, so refused requests don't start collection.
    routes.use('*', async (_c, next) => {
        ensureStarted();
        await next();
    });
    if (!monitor.config.authorize && !monitor.config.publicAccess) monitor.logger?.warn(ACCESS_NOT_CONFIGURED);

    // Script origins the dashboard may load, for the CSP.
    const cfg = monitor.config;
    const scriptUrls = cfg.inlineCharts
        ? []
        : [cfg.chartjsUrl ?? DEFAULT_CHARTJS_URL, cfg.chartAdapterUrl ?? DEFAULT_ADAPTER_URL];


    // Dashboard page
    routes.get('/', async (c) => {
        const snapshot = await monitor.getMetricsSnapshot();
        const nonce = generateNonce();
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
        const custom = metrics.size ? metrics.list() : undefined;
        return c.json({ snapshot, charts: monitor.getChartData(), health, custom }, 200, NO_STORE);
    });

    // /health, /prometheus and (optionally) /api/stream
    registerCommonRoutes(routes, monitor, { enableStream: options.enableStream, metrics });

    return {
        middleware,
        routes,
        start: () => {
            state = 'running';
            monitor.start();
        },
        stop: () => {
            state = 'stopped';
            monitor.stop();
        },
        trackRateLimit: (blocked: boolean) => monitor.trackRateLimitEvent(blocked),
        // Reading metrics counts as use: start collecting if nothing has yet.
        getMetrics: () => {
            ensureStarted();
            return monitor.getMetricsSnapshot();
        },
        getCharts: () => {
            ensureStarted();
            return monitor.getChartData();
        },
        getHealth: () => {
            ensureStarted();
            return monitor.getHealthReport();
        },
        resetStats: () => monitor.resetStats(),
        counter: metrics.counter,
        gauge: metrics.gauge,
        monitor,
        isEdgeMode: options.isEdgeMode
    };
}
