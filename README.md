# hono-status-monitor

[![npm version](https://img.shields.io/npm/v/hono-status-monitor.svg?style=flat-square)](https://www.npmjs.com/package/hono-status-monitor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

Real-time server monitoring dashboard for **Hono.js** applications with WebSocket updates. Express-status-monitor style metrics powered by Socket.io.

![Status Monitor Dashboard](https://via.placeholder.com/800x450/1a1a1a/fff?text=Status+Monitor+Dashboard)

## ✨ Features

| Feature | Description |
|---------|-------------|
| **7 Real-Time Metrics** | CPU, Memory, Heap, Load Average, Response Time, RPS, Event Loop Lag |
| **Response Percentiles** | P50, P95, P99 latency tracking for accurate performance insights |
| **Route Analytics** | Top routes by traffic, slowest routes, routes with most errors |
| **Error Tracking** | Recent errors with timestamps, paths, and status codes |
| **Visual Alerts** | Automatic warnings when CPU >80%, Memory >90%, Response >500ms |
| **Dark Mode** | Toggle with localStorage persistence |
| **WebSocket Updates** | Real-time updates via Socket.io (1 second interval) |
| **Pluggable Health Checks** | Optional database/service health monitoring |
| **Configurable** | Custom thresholds, paths, titles, and more |

## 📦 Installation

```bash
npm install hono-status-monitor
# or
yarn add hono-status-monitor
# or
pnpm add hono-status-monitor
```

## 🚀 Quick Start

```typescript
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { statusMonitor } from 'hono-status-monitor';

const app = new Hono();

// Create status monitor
const monitor = statusMonitor();

// Add middleware to track ALL requests (must be first!)
app.use('*', monitor.middleware);

// Mount status dashboard at /status
app.route('/status', monitor.routes);

// Your routes
app.get('/', (c) => c.text('Hello World!'));

// Start server
const server = serve({ fetch: app.fetch, port: 3000 });

// Initialize WebSocket for real-time updates
monitor.initSocket(server);

console.log('📊 Status monitor: http://localhost:3000/status');
```

## ⚙️ Configuration

```typescript
const monitor = statusMonitor({
    // Dashboard path (default: '/status')
    path: '/status',
    
    // Dashboard title (default: 'Server Status')
    title: 'My App Status',
    
    // Socket.io path (default: '/status/socket.io')
    socketPath: '/status/socket.io',
    
    // Metrics update interval in ms (default: 1000)
    updateInterval: 1000,
    
    // History retention in seconds (default: 60)
    retentionSeconds: 60,
    
    // Max recent errors to store (default: 10)
    maxRecentErrors: 10,
    
    // Max routes to show in analytics (default: 10)
    maxRoutes: 10,
    
    // Alert thresholds
    alerts: {
        cpu: 80,           // CPU percentage
        memory: 90,        // Memory percentage
        responseTime: 500, // Response time in ms
        errorRate: 5,      // Error rate percentage
        eventLoopLag: 100  // Event loop lag in ms
    },
    
    // Custom database health check (optional)
    healthCheck: async () => {
        const start = performance.now();
        await mongoose.connection.db?.admin().ping();
        return {
            connected: mongoose.connection.readyState === 1,
            latencyMs: performance.now() - start,
            name: 'MongoDB'
        };
    },
    
    // Custom path normalization (optional)
    normalizePath: (path) => {
        return path
            .replace(/\/users\/\d+/g, '/users/:id')
            .replace(/\/posts\/[a-f0-9]{24}/g, '/posts/:id');
    }
});
```

## 📊 Dashboard Sections

### Header
- Server hostname
- Connection status (Live/Offline)
- Dark mode toggle

### Stats Bar
- Uptime
- Total requests
- Active connections
- Error rate

### Response Percentiles
- Average response time
- P50 (median)
- P95
- P99

### Real-Time Charts
- CPU usage
- Memory usage (MB)
- Heap usage (MB)
- Load average
- Response time (ms)
- Requests per second
- Event loop lag (ms)

### Route Analytics
- 🔥 Top Routes (by request count)
- 🐢 Slowest Routes (by avg response time)

### HTTP Status Codes
- 2xx success count
- 3xx redirect count
- 4xx client error count
- 5xx server error count
- Rate limited count

### Recent Errors
- Last 10 errors with timestamp, path, and status code

### Health Checks
- Database connection status and latency
- Heap total and growth rate

### Process Info
- Node.js version
- Platform
- PID
- CPU count

## 🔌 API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /status` | Dashboard HTML page |
| `GET /status/api/metrics` | JSON API with full metrics snapshot |

### JSON API Response

```json
{
  "snapshot": {
    "timestamp": 1704067200000,
    "cpu": 12.5,
    "memoryMB": 256.4,
    "memoryPercent": 15.8,
    "heapUsedMB": 48.2,
    "heapTotalMB": 64.0,
    "loadAvg": 1.25,
    "uptime": 86400,
    "processUptime": 3600,
    "responseTime": 15.4,
    "rps": 125,
    "totalRequests": 450000,
    "activeConnections": 42,
    "eventLoopLag": 2.1,
    "percentiles": {
      "avg": 15.4,
      "p50": 12.0,
      "p95": 45.0,
      "p99": 120.0
    },
    "topRoutes": [...],
    "slowestRoutes": [...],
    "recentErrors": [...],
    "alerts": {
      "cpu": false,
      "memory": false,
      "responseTime": false,
      "errorRate": false,
      "eventLoopLag": false
    },
    "database": {
      "connected": true,
      "latencyMs": 1.2
    }
  },
  "charts": {
    "cpu": [{ "timestamp": 1704067200000, "value": 12.5 }, ...],
    "memory": [...],
    "heap": [...],
    "loadAvg": [...],
    "responseTime": [...],
    "rps": [...],
    "eventLoopLag": [...],
    "errorRate": [...]
  }
}
```

## 🎛️ Advanced Usage

### Rate Limit Tracking

```typescript
// In your rate limiter middleware
import { monitor } from './your-app';

if (isRateLimited) {
    monitor.trackRateLimit(true);  // Track blocked request
    return c.text('Too many requests', 429);
}
monitor.trackRateLimit(false);  // Track allowed request
```

### Custom Path Normalization

Group similar routes for meaningful analytics:

```typescript
const monitor = statusMonitor({
    normalizePath: (path) => {
        return path
            // Replace user IDs
            .replace(/\/users\/\d+/g, '/users/:id')
            // Replace MongoDB ObjectIds
            .replace(/\/[a-f0-9]{24}/g, '/:id')
            // Replace UUIDs
            .replace(/\/[0-9a-f-]{36}/g, '/:uuid');
    }
});
```

### Multiple Health Checks

```typescript
const monitor = statusMonitor({
    healthCheck: async () => {
        const dbStart = performance.now();
        const dbConnected = mongoose.connection.readyState === 1;
        
        if (dbConnected) {
            await mongoose.connection.db?.admin().ping();
        }
        
        return {
            connected: dbConnected,
            latencyMs: performance.now() - dbStart,
            name: 'MongoDB'
        };
    }
});
```

## 🛡️ Security Considerations

The status dashboard exposes server metrics. Consider:

1. **Authentication**: Add middleware to protect the `/status` route
2. **Rate Limiting**: Limit access to the dashboard
3. **Internal Only**: Only expose on internal networks

```typescript
import { basicAuth } from 'hono/basic-auth';

// Protect status routes
app.use('/status/*', basicAuth({
    username: 'admin',
    password: process.env.STATUS_PASSWORD!
}));

app.route('/status', monitor.routes);
```

## 📋 Requirements

- Node.js >= 18.0.0
- Hono.js >= 4.0.0
- @hono/node-server >= 1.0.0

## 🤝 Contributing

Contributions welcome! Please read the [contributing guidelines](CONTRIBUTING.md) first.

## 📄 License

MIT © [Vinit Kumar Goel](https://github.com/vinitkumargoel)

---

Made with ❤️ for the Hono.js community
