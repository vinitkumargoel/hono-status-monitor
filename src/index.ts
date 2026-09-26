// =============================================================================
// HONO STATUS MONITOR
// Real-time server monitoring dashboard for Hono.js (live over SSE / polling)
// Supports Node.js, Bun, Deno, Cloudflare Workers and other edge runtimes
// =============================================================================

import type { StatusMonitor, StatusMonitorConfig } from './types.js';
import { detectPlatform } from './platform.js';
import { createMonitor, type Monitor } from './monitor.js';
import { createEdgeStatusMonitor } from './edge-status.js';
import type { EdgeMonitor } from './monitor-edge.js';
import { assembleStatusMonitor } from './status-factory.js';

// Re-export types
export * from './types.js';
export { generateDashboard } from './dashboard.js';
export { generateEdgeDashboard, type EdgeDashboardProps } from './dashboard-edge.js';
export { createEdgeMonitor, type EdgeMonitor } from './monitor-edge.js';
export {
    detectPlatform,
    isNodeEnvironment,
    isBunEnvironment,
    isDenoEnvironment,
    isCloudflareEnvironment,
    isEdgeEnvironment,
    getPlatformInfo
} from './platform.js';

// Conditionally export Node.js-specific modules
// These will throw errors if imported in edge environments
export { createMonitor, type Monitor } from './monitor.js';
export { StatusMonitorConfigError } from './config.js';
export { createMiddleware, createRequestTrackingMiddleware } from './request-tracking.js';
export {
    isClusterWorker,
    isClusterMaster,
    getWorkerId,
    createClusterAggregator,
    setupClusterPrimary
} from './cluster.js';
export { escapeHtml, toPrometheus } from './format.js';
export { mergeSnapshots, generateInstanceId } from './edge-store.js';
export { defaultNormalizePath } from './metrics-utils.js';
export type { CounterMetric, GaugeMetric, MetricLabels, CustomMetricSeries } from './custom-metrics.js';

/**
 * Create a complete status monitor: tracking middleware plus dashboard, JSON,
 * SSE, health and Prometheus routes. Detects the runtime and picks the full
 * (Node/Bun/Deno) or request-only (edge) collector.
 *
 * The status routes answer 403 until you set `authorize` (recommended) or
 * `publicAccess: true`. Invalid options throw a `StatusMonitorConfigError`.
 * 
 * @example Node.js
 * ```typescript
 * import { Hono } from 'hono';
 * import { serve } from '@hono/node-server';
 * import { statusMonitor } from 'hono-status-monitor';
 * 
 * const app = new Hono();
 * const monitor = statusMonitor({
 *     authorize: (c) => c.req.header('x-status-token') === process.env.STATUS_TOKEN,
 * });
 * 
 * app.use('*', monitor.middleware);
 * app.route('/status', monitor.routes);
 * 
 * serve({ fetch: app.fetch, port: 3000 });
 * ```
 * 
 * @example Cloudflare Workers — prefer the Node-free `/edge` entry
 * ```typescript
 * import { Hono } from 'hono';
 * import { statusMonitor } from 'hono-status-monitor/edge';
 * 
 * const app = new Hono();
 * const monitor = statusMonitor({ publicAccess: true });
 * 
 * app.use('*', monitor.middleware);
 * app.route('/status', monitor.routes);
 * 
 * export default app;
 * ```
 */
export function statusMonitor(config: StatusMonitorConfig = {}): StatusMonitor<Monitor | EdgeMonitor> {
    const platform = detectPlatform();
    return platform === 'node' || platform === 'bun' || platform === 'deno'
        ? createNodeStatusMonitor(config)
        : createEdgeStatusMonitor(config);
}

/**
 * Create a Node.js status monitor with full features
 * Requires Node.js runtime with os, process, http modules
 */
function createNodeStatusMonitor(config: StatusMonitorConfig = {}): StatusMonitor<Monitor> {
    const monitor = createMonitor(config);

    return assembleStatusMonitor(monitor, {
        // Lazily loaded so the dashboard markup can be split out of the entry
        // chunk by bundlers that support code splitting.
        renderDashboard: async (m, snapshot, { nonce }) => {
            const { generateDashboard } = await import('./dashboard.js');
            return generateDashboard({
                hostname: snapshot.hostname,
                uptime: m.formatUptime(snapshot.uptime),
                nonce,
                title: m.config.title,
                pollingInterval: m.config.pollingInterval,
                chartjsUrl: m.config.chartjsUrl,
                chartAdapterUrl: m.config.chartAdapterUrl,
                inlineCharts: m.config.inlineCharts,
                stream: true,
                maxRoutes: m.config.maxRoutes,
                maxRecentErrors: m.config.maxRecentErrors,
                retentionSeconds: m.config.retentionSeconds
            });
        },
        enableStream: true,
        isEdgeMode: false
    });
}

/**
 * Create the request-only edge monitor regardless of the detected runtime.
 */
export function statusMonitorEdge(config: StatusMonitorConfig = {}): StatusMonitor<EdgeMonitor> {
    return createEdgeStatusMonitor(config);
}

// Default export
export default statusMonitor;
