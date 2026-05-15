// =============================================================================
// HONO STATUS MONITOR - REQUEST TRACKING MIDDLEWARE
// Shared request accounting for Node.js and edge monitors
// =============================================================================

interface TrackableMonitor {
    config: {
        path: string;
    };
    trackRequest(path: string, method: string): void;
    trackRequestComplete(path: string, method: string, durationMs: number, statusCode: number): void;
}

function normalizeMountPath(path: string): string {
    const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
    return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, '') : withLeadingSlash;
}

export function isMonitorPath(requestPath: string, monitorPath: string): boolean {
    const normalizedMonitorPath = normalizeMountPath(monitorPath);
    return requestPath === normalizedMonitorPath || requestPath.startsWith(`${normalizedMonitorPath}/`);
}

function getErrorStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;

    const status = 'status' in error ? (error as { status?: unknown }).status : undefined;
    if (typeof status === 'number' && status >= 400 && status <= 599) {
        return status;
    }

    const statusCode = 'statusCode' in error ? (error as { statusCode?: unknown }).statusCode : undefined;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599) {
        return statusCode;
    }

    return undefined;
}

function getResponseStatus(c: any, error?: unknown): number {
    const responseStatus = c.res?.status;
    if (typeof responseStatus === 'number' && responseStatus > 0) {
        return responseStatus;
    }

    if (error) {
        return getErrorStatus(error) ?? 500;
    }

    return 200;
}

/**
 * Create Hono middleware for tracking requests.
 */
export function createRequestTrackingMiddleware(monitor: TrackableMonitor) {
    return async (c: any, next: () => Promise<void>) => {
        const path = c.req.path ?? new URL(c.req.url).pathname;

        if (isMonitorPath(path, monitor.config.path)) {
            await next();
            return;
        }

        const method = c.req.method;
        const startTime = performance.now();
        let thrownError: unknown;

        monitor.trackRequest(path, method);

        try {
            await next();
        } catch (error) {
            thrownError = error;
            throw error;
        } finally {
            const duration = performance.now() - startTime;
            monitor.trackRequestComplete(path, method, duration, getResponseStatus(c, thrownError));
        }
    };
}
