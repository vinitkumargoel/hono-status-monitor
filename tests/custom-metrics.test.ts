import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createMetricRegistry, MAX_SERIES_PER_METRIC } from '../src/custom-metrics';
import { statusMonitor } from '../src/index-edge';

describe('metric registry', () => {
    it('counts per label set and renders Prometheus text', () => {
        const registry = createMetricRegistry();
        const orders = registry.counter('orders_total', 'Orders placed');
        orders.inc({ plan: 'pro' });
        orders.inc({ plan: 'pro' }, 2);
        orders.inc({ plan: 'free' });
        const depth = registry.gauge('queue_depth', 'Jobs waiting');
        depth.set(5);
        depth.inc(undefined, -2);

        const text = registry.toPrometheus('app');
        expect(text).toContain('# TYPE app_orders_total counter');
        expect(text).toContain('app_orders_total{plan="pro"} 3');
        expect(text).toContain('app_orders_total{plan="free"} 1');
        expect(text).toContain('# TYPE app_queue_depth gauge');
        expect(text).toContain('app_queue_depth 3');
        expect(registry.list()).toContainEqual({ name: 'queue_depth', type: 'gauge', help: 'Jobs waiting', labels: {}, value: 3 });
    });

    it('treats label order as irrelevant and escapes label values', () => {
        const registry = createMetricRegistry();
        const c = registry.counter('x');
        c.inc({ a: 1, b: 'q"\n' });
        c.inc({ b: 'q"\n', a: 1 });
        expect(registry.list()).toHaveLength(1);
        expect(registry.toPrometheus('p')).toContain('p_x{a="1",b="q\\" "} 2');
    });

    it('returns the same metric for the same name, and refuses a type clash', () => {
        const registry = createMetricRegistry();
        expect(registry.counter('hits')).toBe(registry.counter('hits'));
        expect(() => registry.gauge('hits')).toThrow(/already registered as a counter/);
    });

    it('rejects bad names, negative counter increments and non-finite values', () => {
        const registry = createMetricRegistry();
        expect(() => registry.counter('bad-name')).toThrow(/Invalid metric name/);
        expect(() => registry.counter('ok').inc({ 'bad-label': 1 })).toThrow(/Invalid label name/);
        expect(() => registry.counter('ok').inc(undefined, -1)).toThrow(/can't decrease/);
        expect(() => registry.gauge('g').set(Number.NaN)).toThrow(/non-finite/);
    });

    it('caps label combinations per metric and warns once', () => {
        const warn = vi.fn();
        const registry = createMetricRegistry(warn);
        const c = registry.counter('by_user');
        for (let i = 0; i < MAX_SERIES_PER_METRIC + 50; i++) c.inc({ user: i });
        expect(registry.list()).toHaveLength(MAX_SERIES_PER_METRIC);
        expect(warn).toHaveBeenCalledTimes(1);
    });
});

describe('custom metrics on the handle', () => {
    it('appear on /prometheus and under custom in /api/metrics', async () => {
        const monitor = statusMonitor({ publicAccess: true, logger: false });
        monitor.counter('signups_total', 'Sign-ups').inc({ source: 'ads' });
        const app = new Hono().route('/status', monitor.routes);

        expect(await (await app.request('/status/prometheus')).text()).toContain('hono_signups_total{source="ads"} 1');
        const body = await (await app.request('/status/api/metrics')).json() as { custom: unknown[] };
        expect(body.custom).toEqual([{ name: 'signups_total', type: 'counter', help: 'Sign-ups', labels: { source: 'ads' }, value: 1 }]);
    });

    it('leave /api/metrics unchanged when none are registered', async () => {
        const monitor = statusMonitor({ publicAccess: true, logger: false });
        const body = await (await monitor.routes.request('/api/metrics')).json() as Record<string, unknown>;
        expect(body).not.toHaveProperty('custom');
    });
});
