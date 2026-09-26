// =============================================================================
// HONO STATUS MONITOR - DENO EXAMPLE
//
//   deno run --allow-net --allow-env --allow-sys examples/deno.ts
//
// The main entry runs the full monitor on Deno: system metrics and SSE.
// (npm:hono-status-monitor/edge gives the request-only build.)
// =============================================================================

import { Hono } from 'npm:hono';
import { statusMonitor } from 'npm:hono-status-monitor';

const app = new Hono();

const monitor = statusMonitor({
    title: 'Deno App Status',
    // Open locally, 403 in production until you add `authorize`.
    publicAccess: Deno.env.get('NODE_ENV') !== 'production',
    groupBy: 'route',
    ignorePaths: ['/favicon.ico']
});

app.use('*', monitor.middleware);
app.route('/status', monitor.routes);

app.get('/', (c) => c.text('Hello from Deno'));
app.get('/users/:id', (c) => c.json({ id: c.req.param('id') }));

const port = Number(Deno.env.get('PORT') ?? 8000);
Deno.serve({ port }, app.fetch);
