// =============================================================================
// HONO STATUS MONITOR - DENO EXAMPLE
//
//   deno run --allow-net --allow-env examples/deno.ts
//
// Uses the Node-free /edge entry: request metrics only (no CPU/memory/SSE).
// =============================================================================

import { Hono } from 'npm:hono';
import { statusMonitor } from 'npm:hono-status-monitor/edge';

const app = new Hono();

const monitor = statusMonitor({
    title: 'Deno App Status',
    groupBy: 'route',
    ignorePaths: ['/favicon.ico']
});

app.use('*', monitor.middleware);
app.route('/status', monitor.routes);

app.get('/', (c) => c.text('Hello from Deno'));
app.get('/users/:id', (c) => c.json({ id: c.req.param('id') }));

const port = Number(Deno.env.get('PORT') ?? 8000);
Deno.serve({ port }, app.fetch);
