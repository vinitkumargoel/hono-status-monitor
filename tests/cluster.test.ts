import { describe, it, expect } from 'vitest';
import { createClusterAggregator } from '../src/cluster';
import { MetricsSnapshot, ChartData } from '../src/types';

describe('ClusterAggregator', () => {
    it('should initialize correctly', () => {
        const aggregator = createClusterAggregator();
        expect(aggregator.workerCount).toBe(0);
    });

    it('should update worker metrics', () => {
        const aggregator = createClusterAggregator();
        const mockMetrics: Partial<MetricsSnapshot> = {
            cpu: 10,
            memoryMB: 100,
        };
        const mockCharts: ChartData = {
            cpu: [],
            memory: [],
            heap: [],
            loadAvg: [],
            responseTime: [],
            rps: [],
            eventLoopLag: [],
            errorRate: []
        };

        aggregator.updateWorkerMetrics({
            type: 'worker-metrics',
            workerId: 1,
            pid: 12345,
            metrics: mockMetrics,
            charts: mockCharts,
        });

        expect(aggregator.workerCount).toBe(1);
        const infos = aggregator.getWorkerInfo();
        expect(infos).toHaveLength(1);
        expect(infos[0].pid).toBe(12345);
        expect(infos[0].cpu).toBe(10);
    });

    it('should aggregate metrics from multiple workers', () => {
        const aggregator = createClusterAggregator();

        // Worker 1
        aggregator.updateWorkerMetrics({
            type: 'worker-metrics',
            workerId: 1,
            pid: 101,
            metrics: { rps: 10, totalRequests: 100, cpu: 20 },
            charts: {} as any
        });

        // Worker 2
        aggregator.updateWorkerMetrics({
            type: 'worker-metrics',
            workerId: 2,
            pid: 102,
            metrics: { rps: 20, totalRequests: 200, cpu: 10 },
            charts: {} as any
        });

        const baseSnapshot: any = {
            cpu: 0,
            rps: 0,
            totalRequests: 0,
            statusCodes: {}
        };

        const aggregated = aggregator.aggregateMetrics(baseSnapshot);

        expect(aggregated.rps).toBe(30); // Sum
        expect(aggregated.totalRequests).toBe(300); // Sum
        expect(aggregated.cpu).toBe(15); // Average (20+10)/2
        expect(aggregated.workerCount).toBe(2);
    });
});
