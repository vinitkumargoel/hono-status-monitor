// =============================================================================
// HONO STATUS MONITOR - BASIC EXAMPLE
// Shows how to integrate the status monitor with a Hono.js application
// =============================================================================

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { statusMonitor } from '../src/index.js';

// Create Hono app
const app = new Hono();

// Create status monitor with optional configuration
const monitor = statusMonitor({
    path: '/status',
    title: 'My App Status',
    alerts: {
        cpu: 80,          // Alert when CPU > 80%
        memory: 90,       // Alert when memory > 90%
        responseTime: 500 // Alert when response time > 500ms
    },
    // Optional: Custom database health check
    healthCheck: async () => {
        // Replace with your actual database ping
        const start = performance.now();
        // await db.ping();
        return {
            connected: true,
            latencyMs: performance.now() - start,
            name: 'MongoDB'
        };
    }
});

// Add middleware to track ALL requests (must be first middleware)
app.use('*', monitor.middleware);

// Mount status routes at /status
app.route('/status', monitor.routes);

// Your application routes
app.get('/', (c) => c.text('Hello World!'));

app.get('/api/users', (c) => {
    return c.json({ users: ['Alice', 'Bob', 'Charlie'] });
});

app.get('/api/slow', async (c) => {
    // Simulate slow endpoint
    await new Promise(r => setTimeout(r, 200));
    return c.json({ message: 'This was slow' });
});

// Start server
const port = 3000;
console.log(`🚀 Server running at http://localhost:${port}`);
console.log(`📊 Status monitor at http://localhost:${port}/status`);

const server = serve({
    fetch: app.fetch,
    port
});

// Initialize WebSocket for real-time updates
monitor.initSocket(server);
