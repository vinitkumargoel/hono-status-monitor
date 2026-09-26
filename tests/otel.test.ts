// OpenTelemetry bridge: instrument registration, batch collection, error path.
import { describe, it, expect, vi } from 'vitest';
import {
    registerOtelMetrics,
    type BatchObservableCallbackLike,
    type MeterLike,
    type ObservableLike,
    type OtelAttributes,
} from '../src/otel';
import { statusMonitor } from '../src/index-edge';
import type { MetricsSnapshot } from '../src/types';

interface Instrument extends ObservableLike {
    name: string;
    kind: 'gauge' | 'counter';
    unit?: string;
    description?: string;
}

interface Observation {
    name: string;
    value: number;
    attributes?: OtelAttributes;
}

/** Minimal in-memory Meter: records instruments and drives batch callbacks on collect(). */
function fakeMeter() {
    const instruments: Instrument[] = [];
    const batches: { cb: BatchObservableCallbackLike; observables: ObservableLike[] }[] = [];
    const create = (kind: Instrument['kind']) => (name: string, opts?: { unit?: string; description?: string }) => {
        const inst: Instrument = {
            name,
            kind,
            unit: opts?.unit,
            description: opts?.description,
            addCallback: () => {},
            removeCallback: () => {},
        };
        instruments.push(inst);
        return inst;
    };
    const meter: MeterLike = {
        createObservableGauge: create('gauge'),
        createObservableCounter: create('counter'),
        addBatchObservableCallback: (cb, observables) => {
            batches.push({ cb, observables });
        },
        removeBatchObservableCallback: (cb, observables) => {
            const i = batches.findIndex((b) => b.cb === cb && b.observables === observables);
            if (i >= 0) batches.splice(i, 1);
        },
    };
    const collect = async (): Promise<Observation[]> => {
        const out: Observation[] = [];
        for (const { cb, observables } of batches) {
            await cb({
                observe: (o, value, attributes) => {
                    if (!observables.includes(o)) throw new Error('observed an unregistered instrument');
                    out.push({ name: (o as Instrument).name, value, attributes });
                },
            });
        }
        return out;
    };
    return { meter, instruments, batches, collect };
}

function snapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
    return {
        rps: 12.5,
        responseTime: 42,
        errorRate: 2.5,
        activeConnections: 3,
        totalRequests: 1000,
        percentiles: { p50: 10, p95: 80, p99: 150, avg: 42 },
        statusCodes: { '200': 950, '404': 25, '500': 25 },
        cpu: 17,
        memoryMB: 512,
        memoryPercent: 40,
        heapUsedMB: 64,
        heapTotalMB: 128,
        eventLoopLag: 1.5,
        loadAvg: 0.75,
        ...overrides,
    } as MetricsSnapshot;
}

const find = (obs: Observation[], name: string, attrs?: OtelAttributes) =>
    obs.filter((o) => o.name === name && (!attrs || JSON.stringify(o.attributes) === JSON.stringify(attrs)));

describe('registerOtelMetrics', () => {
    it('registers instruments with OTel-style names and units', () => {
        const { meter, instruments } = fakeMeter();
        registerOtelMetrics(meter, { getMetrics: async () => snapshot() });
        const byName = Object.fromEntries(instruments.map((i) => [i.name, i]));
        expect(byName['hono.http.request.rate']).toMatchObject({ kind: 'gauge', unit: '{request}/s' });
        expect(byName['hono.http.response_time']).toMatchObject({ kind: 'gauge', unit: 'ms' });
        expect(byName['hono.http.error_rate']).toMatchObject({ kind: 'gauge', unit: '%' });
        expect(byName['hono.http.requests']).toMatchObject({ kind: 'counter', unit: '{request}' });
        expect(byName['hono.http.responses']).toMatchObject({ kind: 'counter' });
        expect(byName['hono.memory.used']).toMatchObject({ kind: 'gauge', unit: 'By' });
        for (const i of instruments) expect(i.description).toBeTruthy();
    });

    it('observes snapshot values with quantile and status attributes', async () => {
        const { meter, collect } = fakeMeter();
        registerOtelMetrics(meter, { getMetrics: async () => snapshot() });
        const obs = await collect();

        expect(find(obs, 'hono.http.request.rate')[0].value).toBe(12.5);
        expect(find(obs, 'hono.http.response_time')[0].value).toBe(42);
        expect(find(obs, 'hono.http.error_rate')[0].value).toBe(2.5);
        expect(find(obs, 'hono.http.active_requests')[0].value).toBe(3);
        expect(find(obs, 'hono.http.requests')[0].value).toBe(1000);

        expect(find(obs, 'hono.http.response_time.quantile', { quantile: '0.5' })[0].value).toBe(10);
        expect(find(obs, 'hono.http.response_time.quantile', { quantile: '0.95' })[0].value).toBe(80);
        expect(find(obs, 'hono.http.response_time.quantile', { quantile: '0.99' })[0].value).toBe(150);

        expect(find(obs, 'hono.http.responses', { status: '200' })[0].value).toBe(950);
        expect(find(obs, 'hono.http.responses', { status: '500' })[0].value).toBe(25);
        expect(find(obs, 'hono.http.responses')).toHaveLength(3);

        expect(find(obs, 'hono.cpu.usage')[0].value).toBe(17);
        expect(find(obs, 'hono.memory.used')[0].value).toBe(512 * 1024 * 1024);
        expect(find(obs, 'hono.heap.used')[0].value).toBe(64 * 1024 * 1024);
        expect(find(obs, 'hono.heap.total')[0].value).toBe(128 * 1024 * 1024);
        expect(find(obs, 'hono.event_loop.lag')[0].value).toBe(1.5);
        expect(find(obs, 'hono.system.load_average.1m')[0].value).toBe(0.75);
    });

    it('computes one snapshot per collection cycle', async () => {
        const { meter, collect, batches } = fakeMeter();
        const getMetrics = vi.fn(async () => snapshot());
        registerOtelMetrics(meter, { getMetrics });
        expect(batches).toHaveLength(1);
        expect(getMetrics).not.toHaveBeenCalled();

        await collect();
        expect(getMetrics).toHaveBeenCalledTimes(1);
        await collect();
        expect(getMetrics).toHaveBeenCalledTimes(2);
    });

    it('omits system instruments with includeSystem: false', async () => {
        const { meter, instruments, collect } = fakeMeter();
        registerOtelMetrics(meter, { getMetrics: async () => snapshot() }, { includeSystem: false });
        const names = instruments.map((i) => i.name);
        for (const n of ['cpu.usage', 'memory.used', 'memory.usage', 'heap.used', 'heap.total', 'event_loop.lag']) {
            expect(names).not.toContain(`hono.${n}`);
        }
        expect(names).toContain('hono.http.requests');
        const obs = await collect();
        expect(obs.every((o) => o.name.startsWith('hono.http.'))).toBe(true);
    });

    it('applies and sanitizes a custom prefix', () => {
        const { meter, instruments } = fakeMeter();
        registerOtelMetrics(meter, { getMetrics: async () => snapshot() }, { prefix: 'my app' });
        expect(instruments.every((i) => i.name.startsWith('my_app.'))).toBe(true);
    });

    it('skips non-finite values', async () => {
        const { meter, collect } = fakeMeter();
        registerOtelMetrics(meter, {
            getMetrics: async () => snapshot({ rps: Number.NaN, responseTime: Number.POSITIVE_INFINITY }),
        });
        const obs = await collect();
        expect(find(obs, 'hono.http.request.rate')).toHaveLength(0);
        expect(find(obs, 'hono.http.response_time')).toHaveLength(0);
        expect(find(obs, 'hono.http.requests')).toHaveLength(1);
    });

    it('unregister detaches the callback and is idempotent', async () => {
        const { meter, collect, batches } = fakeMeter();
        const getMetrics = vi.fn(async () => snapshot());
        const reg = registerOtelMetrics(meter, { getMetrics });
        const remove = vi.spyOn(meter, 'removeBatchObservableCallback');
        reg.unregister();
        reg.unregister();
        expect(remove).toHaveBeenCalledTimes(1);
        expect(batches).toHaveLength(0);
        expect(await collect()).toEqual([]);
        expect(getMetrics).not.toHaveBeenCalled();
    });

    it('skips the cycle when the snapshot fails, without throwing', async () => {
        const { meter, collect } = fakeMeter();
        const onError = vi.fn();
        const boom = new Error('boom');
        const getMetrics = vi
            .fn<() => Promise<MetricsSnapshot>>()
            .mockRejectedValueOnce(boom)
            .mockImplementationOnce(() => {
                throw boom; // synchronous throw
            })
            .mockResolvedValue(snapshot());
        registerOtelMetrics(meter, { getMetrics }, { onError });

        await expect(collect()).resolves.toEqual([]);
        await expect(collect()).resolves.toEqual([]);
        expect(onError).toHaveBeenCalledTimes(2);
        expect(onError).toHaveBeenCalledWith(boom);
        expect((await collect()).length).toBeGreaterThan(0);
    });

    it('works against a real edge monitor handle', async () => {
        const { meter, collect } = fakeMeter();
        const monitor = statusMonitor({ publicAccess: true });
        registerOtelMetrics(meter, monitor, { includeSystem: false });
        const obs = await collect();
        expect(find(obs, 'hono.http.requests')).toHaveLength(1);
        expect(find(obs, 'hono.http.response_time.quantile')).toHaveLength(3);
    });
});
