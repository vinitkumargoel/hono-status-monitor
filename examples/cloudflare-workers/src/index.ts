// =============================================================================
// HONO STATUS MONITOR - CLOUDFLARE WORKERS EXAMPLE
// Request metrics per isolate, aggregated across isolates through Workers KV.
//
//   npx wrangler kv namespace create STATUS_KV   # put the id in wrangler.toml
//   npx wrangler secret put STATUS_TOKEN
//   npx wrangler dev
// =============================================================================

import { Hono, type ExecutionContext } from 'hono';
import { timingSafeEqual } from 'hono/utils/buffer';
import { statusMonitor, type StatusStore } from 'hono-status-monitor/edge';

/** Bindings from wrangler.toml. A KV namespace satisfies `StatusStore`. */
interface Env {
    STATUS_KV: StatusStore;
    STATUS_TOKEN?: string;
}

type App = Hono<{ Bindings: Env }>;

/**
 * Bindings are only available inside `fetch`, so the monitor and app are
 * built on the first request and reused for the lifetime of the isolate.
 * Creating a monitor per request would reset its counters every time.
 */
function createApp(env: Env): App {
    const monitor = statusMonitor({
        title: 'Worker Status',
        store: env.STATUS_KV,          // fleet-wide numbers across isolates
        storeWriteInterval: 60_000,    // one KV write per isolate per minute
        groupBy: 'route',              // group as /users/:id, not /users/1, /users/2...
        ignorePaths: ['/favicon.ico'],
        // Every status route, /health included, requires the x-token header.
        authorize: async (c) => {
            const token = env.STATUS_TOKEN;
            if (!token) return false;  // never compare against an empty secret
            return timingSafeEqual(c.req.header('x-token') ?? '', token);
        }
    });

    const app: App = new Hono<{ Bindings: Env }>();
    app.use('*', monitor.middleware);
    app.route('/status', monitor.routes);

    app.get('/', (c) => c.text('Hello from Workers'));
    app.get('/users/:id', (c) => c.json({ id: c.req.param('id') }));

    return app;
}

let app: App | undefined;

export default {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
        app ??= createApp(env);
        return app.fetch(request, env, ctx);
    }
};
