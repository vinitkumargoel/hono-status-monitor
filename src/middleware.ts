// =============================================================================
// HONO STATUS MONITOR - MIDDLEWARE
// Request tracking middleware for Hono.js
// =============================================================================

import type { Monitor } from './monitor.js';
import { createRequestTrackingMiddleware } from './request-tracking.js';

/**
 * Create Hono middleware for tracking requests
 */
export function createMiddleware(monitor: Monitor) {
    return createRequestTrackingMiddleware(monitor);
}
