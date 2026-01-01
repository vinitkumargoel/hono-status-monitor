// =============================================================================
// HONO STATUS MONITOR - MIDDLEWARE
// Request tracking middleware for Hono.js
// =============================================================================

import type { Monitor } from './monitor.js';

/**
 * Create Hono middleware for tracking requests
 */
export function createMiddleware(monitor: Monitor) {
    const statusPath = monitor.config.path;

    return async (c: any, next: () => Promise<void>) => {
        // Skip tracking for status routes
        if (c.req.path.startsWith(statusPath)) {
            await next();
            return;
        }

        const path = c.req.path;
        const method = c.req.method;

        // Track request start
        monitor.trackRequest(path, method);

        const startTime = performance.now();

        // Process request
        await next();

        // Calculate response time
        const endTime = performance.now();
        const duration = endTime - startTime;

        // Track completion with all metrics
        monitor.trackRequestComplete(path, method, duration, c.res.status);
    };
}
