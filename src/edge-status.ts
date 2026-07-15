// =============================================================================
// HONO STATUS MONITOR - EDGE STATUS FACTORY
// Shared route and middleware assembly for edge-compatible entry points
// =============================================================================

import { Hono } from 'hono';
import type { StatusMonitorConfig } from './types.js';
import { createEdgeMonitor } from './monitor-edge.js';
import { generateEdgeDashboard } from './dashboard.js';
import { createRequestTrackingMiddleware } from './request-tracking.js';
import { createAuthGuard, registerCommonRoutes } from './routes.js';

export function createEdgeStatusMonitor(config: StatusMonitorConfig = {}) {
    const monitor = createEdgeMonitor(config);
    const routes = new Hono();
    const middleware = createRequestTrackingMiddleware(monitor);

    const guard = createAuthGuard(monitor.config.authorize);
    if (guard) routes.use('*', guard);

    routes.get('/', async (c) => {
        const snapshot = await monitor.getMetricsSnapshot();
        const html = generateEdgeDashboard({
            hostname: snapshot.hostname,
            uptime: monitor.formatUptime(snapshot.uptime),
            title: monitor.config.title,
            pollingInterval: monitor.config.pollingInterval,
            chartjsUrl: monitor.config.chartjsUrl,
            chartAdapterUrl: monitor.config.chartAdapterUrl,
            inlineCharts: monitor.config.inlineCharts
        });
        return c.html(html);
    });

    routes.get('/api/metrics', async (c) => {
        return c.json({
            snapshot: await monitor.getMetricsSnapshot(),
            charts: monitor.getChartData()
        });
    });

    // /health and /prometheus (no SSE stream on edge isolates)
    registerCommonRoutes(routes, monitor, { enableStream: false });

    monitor.start();

    return {
        /** Hono middleware for tracking all requests */
        middleware,
        /** Pre-configured Hono routes for dashboard and API */
        routes,
        /** Initialize Socket.io - not available in edge, returns null */
        initSocket: () => null,
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
        isEdgeMode: true
    };
}
