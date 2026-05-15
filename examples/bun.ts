// =============================================================================
// HONO STATUS MONITOR - BUN EXAMPLE
// Shows how to integrate the status monitor with Bun.serve
// =============================================================================

import { Hono } from 'hono';
import { statusMonitor } from '../src/index.js';

const app = new Hono();

const monitor = statusMonitor({
    path: '/status',
    title: 'Bun App Status'
});

app.use('*', monitor.middleware);
app.route('/status', monitor.routes);

app.get('/', (c) => c.text('Hello from Bun!'));

app.get('/api/users', (c) => {
    return c.json({ users: ['Alice', 'Bob', 'Charlie'] });
});

app.get('/api/slow', async (c) => {
    await new Promise(resolve => setTimeout(resolve, 200));
    return c.json({ message: 'This was slow' });
});

const port = Number(process.env.PORT ?? 3000);

Bun.serve({
    fetch: app.fetch,
    port
});

console.log(`Server running at http://localhost:${port}`);
console.log(`Status monitor at http://localhost:${port}/status`);
