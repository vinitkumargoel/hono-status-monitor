// =============================================================================
// HONO STATUS MONITOR - NODE.JS EXAMPLE
//
//   npm install hono @hono/node-server hono-status-monitor
//   STATUS_TOKEN=secret npx tsx examples/basic.ts
//   curl -H 'x-token: secret' http://localhost:3000/status/api/metrics
// =============================================================================

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { timingSafeEqual } from 'hono/utils/buffer';
import { statusMonitor } from 'hono-status-monitor';

const app = new Hono();
const token = process.env.STATUS_TOKEN;

const monitor = statusMonitor({
    path: '/status',                        // keep in sync with app.route below
    title: 'My App Status',
    // The status routes answer 403 until authorize or publicAccess is set.
    // Reject when the secret is unset: timingSafeEqual('', '') is true.
    authorize: async (c) => !!token && timingSafeEqual(c.req.header('x-token') ?? '', token),
    groupBy: 'route',                       // /users/:id instead of /users/1, /users/2...
    ignorePaths: ['/favicon.ico', '/assets/*'],
    alerts: { cpu: 80, memory: 90, responseTime: 500 },
    healthChecks: {
        // Replace with a real dependency ping.
        database: async () => {
            const start = performance.now();
            // await db.ping();
            return { connected: true, latencyMs: performance.now() - start };
        }
    },
    healthCheckTimeout: 3000
});

app.use('*', monitor.middleware);           // first, so every request is tracked
app.route('/status', monitor.routes);

app.get('/', (c) => c.text('Hello World!'));
app.get('/users/:id', (c) => c.json({ id: c.req.param('id') }));
app.get('/slow', async (c) => {
    await new Promise((r) => setTimeout(r, 200));
    return c.json({ message: 'This was slow' });
});

const port = 3000;
serve({ fetch: app.fetch, port });
console.log(`Dashboard at http://localhost:${port}/status`);
