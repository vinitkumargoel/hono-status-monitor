// =============================================================================
// HONO STATUS MONITOR - VERCEL EDGE / NEXT.JS APP ROUTER EXAMPLE
//
// Save as app/api/[[...route]]/route.ts in a Next.js project. The dashboard is
// then served at /api/status.
// =============================================================================

import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { statusMonitor } from 'hono-status-monitor/edge';

export const runtime = 'edge';

const app = new Hono().basePath('/api');

const monitor = statusMonitor({
    // The full request path, basePath included, so the dashboard's own polls
    // are not counted as traffic.
    path: '/api/status',
    groupBy: 'route'
});

app.use('*', monitor.middleware);
app.route('/status', monitor.routes);

app.get('/hello', (c) => c.json({ message: 'Hello from Vercel Edge' }));

export const GET = handle(app);
export const POST = handle(app);
