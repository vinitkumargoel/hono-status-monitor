// =============================================================================
// HONO STATUS MONITOR - EDGE ENTRY POINT
// For Cloudflare Workers / Edge environments only
// No Node.js dependencies (os, cluster, socket.io, etc.)
// =============================================================================

import type { StatusMonitorConfig } from './types.js';
import { createEdgeStatusMonitor } from './edge-status.js';

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
    return createEdgeStatusMonitor(config);
}

// Also export as statusMonitorEdge for clarity
export const statusMonitorEdge = statusMonitor;

// Default export
export default statusMonitor;
