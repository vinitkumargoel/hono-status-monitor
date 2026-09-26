// =============================================================================
// HONO STATUS MONITOR - SHARED ROUTE WIRING
// Auth guard, /health, /prometheus and SSE stream — shared by Node & edge.
// =============================================================================

import type { Hono } from 'hono';
import { toPrometheus } from './format.js';
import type { MetricsSnapshot, ChartData, HealthReport } from './types.js';
import type { RouteHistogram } from './stats-core.js';

/** Status data is live; never let a proxy or browser cache it. */
export const NO_STORE: Record<string, string> = { 'Cache-Control': 'no-store' };

interface CommonRouteMonitor {
    config: {
        prometheus: boolean;
        prometheusPrefix: string;
        prometheusHistogram?: boolean;
        pollingInterval: number;
        maxStreamClients?: number;
        authorize?: (c: any) => boolean | Promise<boolean>;
    };
    getMetricsSnapshot: () => Promise<MetricsSnapshot>;
    getChartData: () => ChartData;
    getHealthReport: (maxAgeMs?: number) => Promise<HealthReport>;
    healthConfigured?: boolean;
    getHistograms?: () => RouteHistogram[];
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
        return c.json(report, report.status === 'ok' ? 200 : 503, NO_STORE);
    });

    // Prometheus / OpenMetrics scrape endpoint.
    if (monitor.config.prometheus) {
        routes.get('/prometheus', async (c) => {
            const snapshot = await monitor.getMetricsSnapshot();
            const histograms = monitor.config.prometheusHistogram ? monitor.getHistograms?.() : undefined;
            const body = toPrometheus(snapshot, monitor.config.prometheusPrefix, histograms);
            return c.body(body, 200, {
                ...NO_STORE,
                'Content-Type': 'text/plain; version=0.0.4; charset=utf-8'
            });
        });
    }

    // Server-Sent Events stream — push metrics instead of client polling.
    if (options.enableStream) {
        const broadcaster = createBroadcaster(monitor);
        routes.get('/api/stream', (c) => {
            const maxClients = monitor.config.maxStreamClients ?? 100;
            if (broadcaster.size >= maxClients) {
                return c.json({ error: 'Too many stream clients' }, 503, { ...NO_STORE, 'Retry-After': '30' });
            }
            return broadcaster.connect(c.req.raw.signal);
        });
    }
}

type Client = ReadableStreamDefaultController<Uint8Array>;

/**
 * One timer and one snapshot per tick for all open streams of a monitor,
 * instead of a timer and a snapshot per connection. The timer only runs while
 * at least one client is connected.
 */
function createBroadcaster(monitor: CommonRouteMonitor) {
    const interval = Math.max(250, monitor.config.pollingInterval);
    const encoder = new TextEncoder();
    const clients = new Set<Client>();
    let timer: ReturnType<typeof setInterval> | null = null;
    let last: Uint8Array | null = null;

    const drop = (client: Client) => {
        if (!clients.delete(client)) return;
        // Close so the socket is released; guarded because the controller may
        // already be closed (client gone, cancel() ran).
        try { client.close(); } catch { /* already closed */ }
        if (clients.size === 0 && timer) {
            clearInterval(timer);
            timer = null;
            last = null;
        }
    };

    const frame = async (): Promise<Uint8Array> => {
        const [snapshot, health] = await Promise.all([
            monitor.getMetricsSnapshot(),
            monitor.healthConfigured ? monitor.getHealthReport(Math.max(5000, interval)) : undefined
        ]);
        const charts = monitor.getChartData();
        return encoder.encode(`data: ${JSON.stringify({ snapshot, charts, health })}\n\n`);
    };

    const send = (client: Client, chunk: Uint8Array) => {
        try {
            client.enqueue(chunk);
        } catch {
            drop(client);
        }
    };

    const tick = async () => {
        if (clients.size === 0) return;
        try {
            last = await frame();
        } catch {
            // Snapshot failed: end every stream rather than hold them open
            // producing nothing. EventSource clients reconnect on their own.
            for (const client of [...clients]) drop(client);
            return;
        }
        for (const client of [...clients]) send(client, last);
    };

    return {
        get size() {
            return clients.size;
        },
        connect(signal?: AbortSignal): Response {
            let self: Client | null = null;
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    self = controller;
                    if (signal?.aborted) {
                        try { controller.close(); } catch { /* ignore */ }
                        return;
                    }
                    signal?.addEventListener('abort', () => drop(controller), { once: true });
                    clients.add(controller);
                    // A new client gets data immediately: the latest frame if one
                    // is fresh, otherwise its own.
                    if (last) send(controller, last);
                    else frame().then((chunk) => send(controller, chunk), () => drop(controller));
                    if (!timer) {
                        timer = setInterval(tick, interval);
                        // An open stream shouldn't by itself keep the process alive.
                        (timer as { unref?: () => void }).unref?.();
                    }
                },
                cancel() {
                    if (self) drop(self);
                }
            });
            return new Response(stream, {
                headers: {
                    ...NO_STORE,
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache, no-transform',
                    Connection: 'keep-alive'
                }
            });
        }
    };
}
