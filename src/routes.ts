// =============================================================================
// HONO STATUS MONITOR - SHARED ROUTE WIRING
// Auth guard, /health, /prometheus and SSE stream — shared by Node & edge.
// =============================================================================

import type { Hono } from 'hono';
import { toPrometheus } from './format.js';
import type { MetricsSnapshot, ChartData, HealthReport } from './types.js';

interface CommonRouteMonitor {
    config: {
        prometheus: boolean;
        prometheusPrefix: string;
        pollingInterval: number;
        authorize?: (c: any) => boolean | Promise<boolean>;
    };
    getMetricsSnapshot: () => Promise<MetricsSnapshot>;
    getChartData: () => ChartData;
    getHealthReport: () => Promise<HealthReport>;
}

/**
 * Build a Hono middleware that enforces `config.authorize`, or null if none set.
 * A falsy return (or thrown error) yields 401.
 */
export function createAuthGuard(
    authorize?: (c: any) => boolean | Promise<boolean>
): ((c: any, next: () => Promise<void>) => Promise<Response | void>) | null {
    if (!authorize) return null;
    return async (c: any, next: () => Promise<void>) => {
        let ok = false;
        try {
            ok = await authorize(c);
        } catch {
            ok = false;
        }
        if (!ok) {
            return c.json({ error: 'Unauthorized' }, 401);
        }
        return next();
    };
}

/**
 * Register /health, /prometheus and (optionally) /api/stream on the given routes.
 * The auth guard, if any, must be applied by the caller before mounting.
 */
export function registerCommonRoutes(
    routes: Hono,
    monitor: CommonRouteMonitor,
    options: { enableStream?: boolean } = {}
): void {
    // Health endpoint — 200 when all checks pass, 503 when degraded.
    routes.get('/health', async (c) => {
        const report = await monitor.getHealthReport();
        return c.json(report, report.status === 'ok' ? 200 : 503);
    });

    // Prometheus / OpenMetrics scrape endpoint.
    if (monitor.config.prometheus) {
        routes.get('/prometheus', async (c) => {
            const snapshot = await monitor.getMetricsSnapshot();
            const body = toPrometheus(snapshot, monitor.config.prometheusPrefix);
            return c.body(body, 200, {
                'Content-Type': 'text/plain; version=0.0.4; charset=utf-8'
            });
        });
    }

    // Server-Sent Events stream — push metrics instead of client polling.
    if (options.enableStream) {
        routes.get('/api/stream', (c) => {
            const interval = Math.max(250, monitor.config.pollingInterval);
            const encoder = new TextEncoder();
            let timer: ReturnType<typeof setInterval> | null = null;
            let closed = false;

            const cleanup = (controller?: ReadableStreamDefaultController) => {
                if (closed) return;
                closed = true;
                if (timer) clearInterval(timer);
                timer = null;
                // Close the stream so the socket is released instead of leaking
                // an open connection that produces nothing. Guarded because the
                // controller may already be closed (client gone, cancel() ran).
                try { controller?.close(); } catch { /* already closed */ }
            };

            // If the client aborts (browser tab closed, fetch cancelled), stop
            // pushing immediately rather than waiting for the next enqueue to throw.
            const signal = c.req.raw.signal;

            const stream = new ReadableStream({
                start(controller) {
                    const onAbort = () => cleanup(controller);
                    if (signal) {
                        if (signal.aborted) return cleanup(controller);
                        signal.addEventListener('abort', onAbort, { once: true });
                    }
                    const push = async () => {
                        if (closed) return;
                        try {
                            const snapshot = await monitor.getMetricsSnapshot();
                            const charts = monitor.getChartData();
                            controller.enqueue(
                                encoder.encode(`data: ${JSON.stringify({ snapshot, charts })}\n\n`)
                            );
                        } catch {
                            // Snapshot failed or the stream is gone — tear down the
                            // connection instead of holding it open indefinitely.
                            cleanup(controller);
                        }
                    };
                    push();
                    timer = setInterval(push, interval);
                },
                cancel() {
                    cleanup();
                }
            });

            return new Response(stream, {
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache, no-transform',
                    Connection: 'keep-alive'
                }
            });
        });
    }
}
