// =============================================================================
// HONO STATUS MONITOR - REQUEST TRACKING MIDDLEWARE
// Shared request accounting for Node.js and edge monitors
// =============================================================================

import type { Context, MiddlewareHandler } from 'hono';

interface TrackableMonitor {
    config: {
        path: string;
        groupBy?: 'path' | 'route';
        ignorePaths?: Array<string | RegExp> | ((path: string) => boolean);
    };
    trackRequest(path: string, method: string): void;
    trackRequestComplete(path: string, method: string, durationMs: number, statusCode: number): void;
    /** Present on the built-in monitors; enables route-pattern grouping. */
    beginRequest?(): void;
    endRequest?(route: string, method: string, durationMs: number, statusCode: number, isPattern?: boolean): void;
    /** Called after each tracked request (edge store persistence). */
    afterRequest?(c: Context): void;
    /** Called once, on the first request, so collection starts lazily. */
    start?(): void;
}

/** Compile `ignorePaths` into a single predicate (or null when empty). */
export function compileIgnore(
    ignore: Array<string | RegExp> | ((path: string) => boolean) | undefined
): ((path: string) => boolean) | null {
    if (!ignore) return null;
    if (typeof ignore === 'function') return ignore;
    if (ignore.length === 0) return null;
    const exact = new Set<string>();
    const prefixes: string[] = [];
    const patterns: RegExp[] = [];
    for (const rule of ignore) {
        if (rule instanceof RegExp) patterns.push(rule);
        else if (rule.endsWith('/*')) prefixes.push(rule.slice(0, -1));
        else exact.add(rule);
    }
    return (path) =>
        exact.has(path) ||
        prefixes.some((p) => path.startsWith(p) || path === p.slice(0, -1)) ||
        patterns.some((re) => { re.lastIndex = 0; return re.test(path); });
}

/**
 * The Hono route pattern that handled the request, or null when only a
 * catch-all (`*`, `/*`) matched — i.e. the request hit no route, and grouping
 * it under the catch-all would lump every 404 together.
 */
function matchedRoutePattern(c: Context): string | null {
    const pattern: unknown = c.req.routePath;
    if (typeof pattern !== 'string' || pattern === '*' || pattern === '/*') return null;
    return pattern;
}

function normalizeMountPath(path: string): string {
    const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
    return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, '') : withLeadingSlash;
}

export function isMonitorPath(requestPath: string, monitorPath: string): boolean {
    return matchesMountPath(requestPath, normalizeMountPath(monitorPath));
}

function matchesMountPath(requestPath: string, mountPath: string): boolean {
    return requestPath === mountPath || requestPath.startsWith(`${mountPath}/`);
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

function getResponseStatus(c: Context, error?: unknown): number {
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
 *
 * Also exported as `createMiddleware` for backwards compatibility.
 */
export function createRequestTrackingMiddleware(monitor: TrackableMonitor): MiddlewareHandler {
    // Fixed for the monitor's lifetime; computed once rather than per request.
    const mountPath = normalizeMountPath(monitor.config.path);
    const ignored = compileIgnore(monitor.config.ignorePaths);
    const { beginRequest, endRequest } = monitor;
    const byRoute = monitor.config.groupBy === 'route' && !!beginRequest && !!endRequest;
    // begin/end create the route at completion, which route grouping needs
    // (the pattern is only known after the handler ran).
    const split = !!beginRequest && !!endRequest;

    let started = false;

    return async (c, next) => {
        if (!started) {
            started = true;
            monitor.start?.();
        }
        const path = c.req.path;

        if (matchesMountPath(path, mountPath) || (ignored && ignored(path))) {
            await next();
            return;
        }

        const method = c.req.method;
        const startTime = performance.now();
        let thrownError: unknown;

        if (split && beginRequest) beginRequest();
        else monitor.trackRequest(path, method);

        try {
            await next();
        } catch (error) {
            thrownError = error;
            throw error;
        } finally {
            const duration = performance.now() - startTime;
            const status = getResponseStatus(c, thrownError);
            if (split && endRequest) {
                const pattern = byRoute ? matchedRoutePattern(c) : null;
                endRequest(pattern ?? path, method, duration, status, pattern !== null);
            } else {
                monitor.trackRequestComplete(path, method, duration, status);
            }
            monitor.afterRequest?.(c);
        }
    };
}

/**
 * Alias of {@link createRequestTrackingMiddleware}. Kept as the name the package
 * has always exported; both are supported.
 */
export const createMiddleware = createRequestTrackingMiddleware;
