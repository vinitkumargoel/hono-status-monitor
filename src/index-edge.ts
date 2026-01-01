// =============================================================================
// HONO STATUS MONITOR - EDGE ENTRY POINT
// For Cloudflare Workers / Edge environments only
// No Node.js dependencies (os, cluster, socket.io, etc.)
// =============================================================================

import { Hono } from 'hono';
import type { StatusMonitorConfig } from './types.js';
import { createEdgeMonitor } from './monitor-edge.js';
import { generateEdgeDashboard } from './dashboard.js';

// Re-export types (these have no Node.js deps)
export type {
    StatusMonitorConfig,
    MetricsSnapshot,
    ChartData,
    RouteStats,
    ErrorEntry,
    PercentileData,
    AlertStatus
} from './types.js';

export { createEdgeMonitor, type EdgeMonitor } from './monitor-edge.js';
export { generateEdgeDashboard } from './dashboard.js';

/**
 * Create a status monitor for Edge/Cloudflare Workers environments
 * 
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { statusMonitor } from 'hono-status-monitor/edge';
 * 
 * const app = new Hono();
 * const monitor = statusMonitor();
 * 
 * app.use('*', monitor.middleware);
 * app.route('/status', monitor.routes);
 * 
 * export default app;
 * ```
 */
export function statusMonitor(config: StatusMonitorConfig = {}) {
    const monitor = createEdgeMonitor(config);
    const routes = new Hono();

    // Create middleware for edge
    const middleware = async (c: any, next: () => Promise<void>) => {
        const path = new URL(c.req.url).pathname;
        const method = c.req.method;

        // Skip status route itself
        if (path.startsWith(config.path || '/status')) {
            return next();
        }

        const start = performance.now();
        monitor.trackRequest(path, method);

        try {
            await next();
        } finally {
            const duration = performance.now() - start;
            const status = c.res?.status || 200;
            monitor.trackRequestComplete(path, method, duration, status);
        }
    };

    // Dashboard page - uses polling mode
    routes.get('/', async (c) => {
        const snapshot = await monitor.getMetricsSnapshot();
        const html = generateEdgeDashboard({
            hostname: snapshot.hostname,
            uptime: monitor.formatUptime(snapshot.uptime),
            title: monitor.config.title,
            pollingInterval: monitor.config.pollingInterval
        });
        return c.html(html);
    });

    // JSON API endpoint
    routes.get('/api/metrics', async (c) => {
        return c.json({
            snapshot: await monitor.getMetricsSnapshot(),
            charts: monitor.getChartData()
        });
    });

    // Start (no-op in edge mode)
    monitor.start();

    return {
        /** Hono middleware for tracking all requests */
        middleware,
        /** Pre-configured Hono routes for dashboard and API */
        routes,
        /** Initialize Socket.io - not available in edge, returns null */
        initSocket: () => null as any,
        /** Track rate limit events for the dashboard */
        trackRateLimit: (blocked: boolean) => monitor.trackRateLimitEvent(blocked),
        /** Get current metrics snapshot */
        getMetrics: () => monitor.getMetricsSnapshot(),
        /** Get chart data for all metrics */
        getCharts: () => monitor.getChartData(),
        /** Stop metrics collection */
        stop: () => monitor.stop(),
        /** Access to the underlying monitor instance */
        monitor,
        /** Whether running in edge mode */
        isEdgeMode: true
    };
}

// Also export as statusMonitorEdge for clarity
export const statusMonitorEdge = statusMonitor;

// Default export
export default statusMonitor;
