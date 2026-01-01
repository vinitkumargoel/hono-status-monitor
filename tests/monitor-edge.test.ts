import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEdgeMonitor } from '../src/monitor-edge';

describe('createEdgeMonitor', () => {
    let monitor: ReturnType<typeof createEdgeMonitor>;

    beforeEach(() => {
        monitor = createEdgeMonitor({
            pollingInterval: 3000,
            retentionSeconds: 60,
        });
    });

    it('should initialize with default configuration', () => {
        expect(monitor.config).toBeDefined();
        expect(monitor.config.path).toBe('/status');
        expect(monitor.config.pollingInterval).toBe(3000);
        expect(monitor.isEdgeMode).toBe(true);
    });

    it('should track requests', async () => {
        monitor.trackRequest('/api/test', 'GET');
        monitor.trackRequestComplete('/api/test', 'GET', 100, 200);

        const snapshot = await monitor.getMetricsSnapshot();

        expect(snapshot.totalRequests).toBe(1);
        expect(snapshot.statusCodes['200']).toBe(1);
        expect(snapshot.isEdgeMode).toBe(true);
    });

    it('should track multiple requests and calculate metrics', async () => {
        monitor.trackRequest('/api/users', 'GET');
        monitor.trackRequestComplete('/api/users', 'GET', 50, 200);

        monitor.trackRequest('/api/posts', 'POST');
        monitor.trackRequestComplete('/api/posts', 'POST', 150, 201);

        monitor.trackRequest('/api/users', 'GET');
        monitor.trackRequestComplete('/api/users', 'GET', 75, 200);

        const snapshot = await monitor.getMetricsSnapshot();

        expect(snapshot.totalRequests).toBe(3);
        expect(snapshot.statusCodes['200']).toBe(2);
        expect(snapshot.statusCodes['201']).toBe(1);
    });

    it('should calculate percentiles', async () => {
        // Add multiple requests with varying response times
        const times = [10, 20, 30, 40, 50, 100, 200, 300, 400, 500];
        times.forEach((time, i) => {
            monitor.trackRequest(`/api/test${i}`, 'GET');
            monitor.trackRequestComplete(`/api/test${i}`, 'GET', time, 200);
        });

        const snapshot = await monitor.getMetricsSnapshot();

        expect(snapshot.percentiles.p50).toBeGreaterThan(0);
        expect(snapshot.percentiles.p95).toBeGreaterThan(snapshot.percentiles.p50);
        expect(snapshot.percentiles.avg).toBeGreaterThan(0);
    });

    it('should track errors', async () => {
        monitor.trackRequest('/api/test', 'GET');
        monitor.trackRequestComplete('/api/test', 'GET', 50, 200);

        monitor.trackRequest('/api/error', 'POST');
        monitor.trackRequestComplete('/api/error', 'POST', 100, 500);

        const snapshot = await monitor.getMetricsSnapshot();

        expect(snapshot.statusCodes['500']).toBe(1);
        expect(snapshot.errorRate).toBe(50); // 1 error out of 2 requests
        expect(snapshot.recentErrors.length).toBe(1);
        expect(snapshot.recentErrors[0].status).toBe(500);
    });

    it('should track rate limit events', async () => {
        monitor.trackRateLimitEvent(true);
        monitor.trackRateLimitEvent(true);
        monitor.trackRateLimitEvent(false);

        const snapshot = await monitor.getMetricsSnapshot();

        expect(snapshot.rateLimitStats.blocked).toBe(2);
        expect(snapshot.rateLimitStats.total).toBe(3);
    });

    it('should return empty/zero values for unavailable system metrics', async () => {
        const snapshot = await monitor.getMetricsSnapshot();

        expect(snapshot.cpu).toBe(0);
        expect(snapshot.memoryMB).toBe(0);
        expect(snapshot.heapUsedMB).toBe(0);
        expect(snapshot.loadAvg).toBe(0);
        expect(snapshot.eventLoopLag).toBe(0);
    });

    it('should format uptime correctly', () => {
        expect(monitor.formatUptime(0)).toBe('0s');
        expect(monitor.formatUptime(65)).toBe('1m 5s');
        expect(monitor.formatUptime(3665)).toBe('1h 1m 5s');
        expect(monitor.formatUptime(90065)).toBe('1d 1h 1m 5s');
    });

    it('should return chart data with available metrics only', () => {
        monitor.trackRequest('/api/test', 'GET');
        monitor.trackRequestComplete('/api/test', 'GET', 100, 200);

        const charts = monitor.getChartData();

        // Available charts
        expect(Array.isArray(charts.responseTime)).toBe(true);
        expect(Array.isArray(charts.rps)).toBe(true);
        expect(Array.isArray(charts.errorRate)).toBe(true);

        // Unavailable charts should be empty
        expect(charts.cpu).toEqual([]);
        expect(charts.memory).toEqual([]);
        expect(charts.heap).toEqual([]);
        expect(charts.loadAvg).toEqual([]);
        expect(charts.eventLoopLag).toEqual([]);
    });

    it('should track route analytics', async () => {
        // Simulate requests to different routes
        for (let i = 0; i < 5; i++) {
            monitor.trackRequest('/api/popular', 'GET');
            monitor.trackRequestComplete('/api/popular', 'GET', 50, 200);
        }

        for (let i = 0; i < 2; i++) {
            monitor.trackRequest('/api/slow', 'GET');
            monitor.trackRequestComplete('/api/slow', 'GET', 500, 200);
        }

        const snapshot = await monitor.getMetricsSnapshot();

        // Top routes by count
        expect(snapshot.topRoutes.length).toBeGreaterThan(0);
        expect(snapshot.topRoutes[0].path).toBe('/api/popular');
        expect(snapshot.topRoutes[0].count).toBe(5);

        // Slowest routes
        expect(snapshot.slowestRoutes.length).toBeGreaterThan(0);
        expect(snapshot.slowestRoutes[0].path).toBe('/api/slow');
    });
});
