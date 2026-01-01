// =============================================================================
// HONO STATUS MONITOR
// Real-time server monitoring dashboard for Hono.js with WebSocket updates
// Supports Node.js and Cloudflare Workers/Edge environments
// =============================================================================

import { Hono } from 'hono';
import type { StatusMonitorConfig } from './types.js';
import { isNodeEnvironment, detectPlatform } from './platform.js';
import { createEdgeMonitor } from './monitor-edge.js';
import { generateDashboard, generateEdgeDashboard } from './dashboard.js';

// Re-export types
export * from './types.js';
export { generateDashboard, generateEdgeDashboard } from './dashboard.js';
export { createEdgeMonitor, type EdgeMonitor } from './monitor-edge.js';
export {
    detectPlatform,
    isNodeEnvironment,
    isCloudflareEnvironment,
    isEdgeEnvironment,
    getPlatformInfo
} from './platform.js';

// Conditionally export Node.js-specific modules
// These will throw errors if imported in edge environments
export { createMonitor, type Monitor } from './monitor.js';
export { createMiddleware } from './middleware.js';
export {
    isClusterWorker,
    isClusterMaster,
    getWorkerId,
    createClusterAggregator
} from './cluster.js';

/**
 * Create a complete status monitor with routes, middleware, and WebSocket
 * Automatically detects the runtime environment and uses the appropriate implementation
 * 
 * @example Node.js
 * ```typescript
 * import { Hono } from 'hono';
 * import { serve } from '@hono/node-server';
 * import { statusMonitor } from 'hono-status-monitor';
 * 
 * const app = new Hono();
 * const monitor = statusMonitor();
 * 
 * app.use('*', monitor.middleware);
 * app.route('/status', monitor.routes);
 * 
 * const server = serve({ fetch: app.fetch, port: 3000 });
 * monitor.initSocket(server);
 * ```
 * 
 * @example Cloudflare Workers
 * ```typescript
 * import { Hono } from 'hono';
 * import { statusMonitor } from 'hono-status-monitor';
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
    // Force platform check if specified in config
    const platform = detectPlatform();
    const useNodeVersion = platform === 'node';

    if (useNodeVersion) {
        // Node.js version with full features
        return createNodeStatusMonitor(config);
    } else {
        // Edge/Cloudflare version with limited features
        return createEdgeStatusMonitor(config);
    }
}

/**
 * Create a Node.js status monitor with full features
 * Requires Node.js runtime with os, process, http modules
 */
function createNodeStatusMonitor(config: StatusMonitorConfig = {}) {
    // Dynamic import to avoid loading Node.js modules in edge
    const { createMonitor } = require('./monitor.js');
    const { createMiddleware } = require('./middleware.js');
    type HttpServer = import('http').Server;

    const monitor = createMonitor(config);
    const middleware = createMiddleware(monitor);
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
        monitor,
        /** Whether running in edge mode */
        isEdgeMode: false
    };
}

/**
 * Create an edge-compatible status monitor with limited features
 * Works in Cloudflare Workers, Vercel Edge, and other edge runtimes
 */
function createEdgeStatusMonitor(config: StatusMonitorConfig = {}) {
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

/**
 * Explicitly create an edge-compatible status monitor
 * Use this when you want to force edge mode regardless of environment
 */
export function statusMonitorEdge(config: StatusMonitorConfig = {}) {
    return createEdgeStatusMonitor(config);
}

// Default export
export default statusMonitor;
