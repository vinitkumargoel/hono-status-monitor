// =============================================================================
// HONO STATUS MONITOR
// Real-time server monitoring dashboard for Hono.js with WebSocket updates
// =============================================================================

import { Hono } from 'hono';
import type { Server as HttpServer } from 'http';
import { createMonitor, type Monitor } from './monitor.js';
import { createMiddleware } from './middleware.js';
import { generateDashboard } from './dashboard.js';
import type { StatusMonitorConfig, HealthCheckResult } from './types.js';

// Re-export types
export * from './types.js';
export { createMonitor, type Monitor } from './monitor.js';
export { createMiddleware } from './middleware.js';
export { generateDashboard } from './dashboard.js';

/**
 * Create a complete status monitor with routes, middleware, and WebSocket
 * 
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { serve } from '@hono/node-server';
 * import { statusMonitor } from 'hono-status-monitor';
 * 
 * const app = new Hono();
 * const monitor = statusMonitor();
 * 
 * // Add middleware to track all requests
 * app.use('*', monitor.middleware);
 * 
 * // Mount status routes
 * app.route('/status', monitor.routes);
 * 
 * // Start server and initialize WebSocket
 * const server = serve({ fetch: app.fetch, port: 3000 });
 * monitor.initSocket(server);
 * ```
 */
export function statusMonitor(config: StatusMonitorConfig = {}) {
    // Create monitor instance
    const monitor = createMonitor(config);

    // Create middleware
    const middleware = createMiddleware(monitor);

    // Create Hono routes
    const routes = new Hono();

    // Dashboard page
    routes.get('/', async (c) => {
        const snapshot = await monitor.getMetricsSnapshot();
        const html = generateDashboard({
            hostname: snapshot.hostname,
            uptime: monitor.formatUptime(snapshot.uptime),
            socketPath: monitor.config.socketPath,
            title: monitor.config.title
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

    // Start metrics collection
    monitor.start();

    return {
        /** Hono middleware for tracking all requests */
        middleware,
        /** Pre-configured Hono routes for dashboard and API */
        routes,
        /** Initialize Socket.io on the HTTP server for real-time updates */
        initSocket: (server: HttpServer) => monitor.initSocket(server),
        /** Track rate limit events for the dashboard */
        trackRateLimit: (blocked: boolean) => monitor.trackRateLimitEvent(blocked),
        /** Get current metrics snapshot */
        getMetrics: () => monitor.getMetricsSnapshot(),
        /** Get chart data for all metrics */
        getCharts: () => monitor.getChartData(),
        /** Stop metrics collection */
        stop: () => monitor.stop(),
        /** Access to the underlying monitor instance */
        monitor
    };
}

// Default export
export default statusMonitor;
