// =============================================================================
// HONO STATUS MONITOR - EDGE ENTRY POINT
// For Cloudflare Workers / Edge environments only
// No Node.js dependencies (os, cluster, socket.io, etc.)
// =============================================================================

import type { StatusMonitorConfig } from './types.js';
import { createEdgeStatusMonitor } from './edge-status.js';

// Re-export types (these have no Node.js deps)
export * from './types.js';

export { createEdgeMonitor, type EdgeMonitor } from './monitor-edge.js';
export { generateEdgeDashboard, type EdgeDashboardProps } from './dashboard-edge.js';
export { escapeHtml, toPrometheus } from './format.js';
export { mergeSnapshots, generateInstanceId } from './edge-store.js';
export { createMiddleware, createRequestTrackingMiddleware } from './request-tracking.js';

// Platform helpers are dependency-free and behave the same on every runtime, so
// they are exported here too. This keeps the edge entry a drop-in replacement
// for the main entry under the `workerd` / `edge-light` export conditions —
// only the genuinely Node-only APIs (createMonitor, cluster helpers,
// generateDashboard) are absent.
export {
    detectPlatform,
    isNodeEnvironment,
    isBunEnvironment,
    isCloudflareEnvironment,
    isEdgeEnvironment,
    getPlatformInfo
} from './platform.js';

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
