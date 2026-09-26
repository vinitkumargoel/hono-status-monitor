// =============================================================================
// HONO STATUS MONITOR - BUN EXAMPLE
//
//   bun add hono hono-status-monitor
//   bun run examples/bun.ts
// =============================================================================

import { Hono } from 'hono';
import { statusMonitor } from 'hono-status-monitor';

const app = new Hono();

const monitor = statusMonitor({
    title: 'Bun App Status',
    // Open locally, 403 in production until you add `authorize`.
    publicAccess: process.env.NODE_ENV !== 'production',
    groupBy: 'route',
    ignorePaths: ['/favicon.ico']
});

app.use('*', monitor.middleware);
app.route('/status', monitor.routes);

app.get('/', (c) => c.text('Hello from Bun!'));
app.get('/users/:id', (c) => c.json({ id: c.req.param('id') }));

const port = Number(process.env.PORT ?? 3000);
Bun.serve({ fetch: app.fetch, port });
console.log(`Dashboard at http://localhost:${port}/status`);
