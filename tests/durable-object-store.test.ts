import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    StatusStoreObject,
    durableObjectStore,
    DO_STORE_MAX_KEY_LENGTH,
    DO_STORE_MAX_VALUE_BYTES,
    type DurableObjectNamespaceLike,
    type DurableObjectStorageLike
} from '../src/durable-object-store';
import { persistSnapshot, loadPeerSnapshots } from '../src/edge-store';
import type { MetricsSnapshot } from '../src/types';

// In-memory stand-in for DurableObjectStorage (values are structured-cloned there).
function fakeStorage(): DurableObjectStorageLike & { data: Map<string, unknown>; alarmAt: number | null } {
    const data = new Map<string, unknown>();
    const s = {
        data,
        alarmAt: null as number | null,
        async get(key: string) { return structuredClone(data.get(key)); },
        async put(key: string, value: unknown) { data.set(key, structuredClone(value)); },
        async delete(keys: string | string[]) {
            const list = Array.isArray(keys) ? keys : [keys];
            let n = 0;
            for (const k of list) if (data.delete(k)) n++;
            return Array.isArray(keys) ? n : n > 0;
        },
        async list({ prefix = '' }: { prefix?: string } = {}) {
            return new Map([...data].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)));
        },
        async getAlarm() { return s.alarmAt; },
        async setAlarm(t: number) { s.alarmAt = t; }
    };
    return s;
}

// Fake namespace: one object per name, reached through the real Request/Response path.
function fakeNamespace() {
    const objects = new Map<string, StatusStoreObject>();
    const storages = new Map<string, ReturnType<typeof fakeStorage>>();
    const calls: { name: string; url: string }[] = [];
    const ns: DurableObjectNamespaceLike = {
        idFromName: (name: string) => ({ name }),
        get: ((id: { name: string }) => ({
            fetch: async (url: string, init: { method: string; headers?: Record<string, string>; body: string }) => {
                calls.push({ name: id.name, url });
                let obj = objects.get(id.name);
                if (!obj) {
                    const storage = fakeStorage();
                    storages.set(id.name, storage);
                    obj = new StatusStoreObject({ storage }, {});
                    objects.set(id.name, obj);
                }
                return obj.fetch(new Request(url, init));
            }
        })) as unknown as DurableObjectNamespaceLike['get']
    };
    return { ns, objects, storages, calls };
}

function rpc(obj: StatusStoreObject, body: unknown, method = 'POST') {
    return obj.fetch(
        new Request('https://status-store/', {
            method,
            body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
        })
    );
}

function snap(over: Partial<MetricsSnapshot>): MetricsSnapshot {
    return {
        timestamp: 0, cpu: 0, memoryMB: 0, memoryPercent: 0, heapUsedMB: 0, heapTotalMB: 0,
        loadAvg: 0, uptime: 0, processUptime: 0, responseTime: 0, rps: 0, statusCodes: {},
        totalRequests: 0, activeConnections: 0, eventLoopLag: 0, hostname: 'w', platform: 'x',
        nodeVersion: 'N/A', pid: 0, cpuCount: 0,
        percentiles: { p50: 0, p95: 0, p99: 0, avg: 0 },
        topRoutes: [], slowestRoutes: [], errorRoutes: [], recentErrors: [],
        alerts: { cpu: false, memory: false, responseTime: false, errorRate: false, eventLoopLag: false },
        gc: { collections: 0, pauseTimeMs: 0, heapGrowthRate: 0 },
        database: { connected: false, poolSize: 0, availableConnections: 0, waitQueueSize: 0, latencyMs: 0 },
        rateLimitStats: { blocked: 0, total: 0 }, errorRate: 0, isEdgeMode: true,
        ...over
    };
}

describe('durableObjectStore round trip', () => {
    it('gets, puts and lists with a prefix', async () => {
        const { ns, calls } = fakeNamespace();
        const store = durableObjectStore(ns);

        expect(await store.get('missing')).toBeNull();
        await store.put('hsm:inst:a', 'A');
        await store.put('hsm:inst:b', 'B', { expirationTtl: 120 });
        await store.put('other:c', 'C');

        expect(await store.get('hsm:inst:a')).toBe('A');
        expect(await store.get('hsm:inst:b')).toBe('B');
        const listed = await store.list({ prefix: 'hsm:inst:' });
        expect(listed.keys.map((k) => k.name).sort()).toEqual(['hsm:inst:a', 'hsm:inst:b']);
        expect((await store.list()).keys).toHaveLength(3);

        // Overwrite replaces the value.
        await store.put('hsm:inst:a', 'A2');
        expect(await store.get('hsm:inst:a')).toBe('A2');

        expect(new Set(calls.map((c) => c.name))).toEqual(new Set(['hono-status-monitor']));
        expect(calls[0].url).toBe('https://status-store/');
    });

    it('uses the named instance', async () => {
        const { ns, calls } = fakeNamespace();
        const a = durableObjectStore(ns, 'fleet-a');
        const b = durableObjectStore(ns, 'fleet-b');
        await a.put('k', '1');
        expect(await b.get('k')).toBeNull();
        expect(await a.get('k')).toBe('1');
        expect(calls.map((c) => c.name)).toContain('fleet-b');
    });

    it('rejects when the object responds with an error', async () => {
        const { ns } = fakeNamespace();
        const store = durableObjectStore(ns);
        await expect(store.put('x'.repeat(DO_STORE_MAX_KEY_LENGTH + 1), 'v')).rejects.toThrow(/400/);
    });

    it('rejects when the transport fails', async () => {
        const ns: DurableObjectNamespaceLike = {
            idFromName: () => ({}),
            get: (() => ({ fetch: async () => { throw new Error('network'); } })) as unknown as DurableObjectNamespaceLike['get']
        };
        await expect(durableObjectStore(ns).get('k')).rejects.toThrow('network');
    });

    it('rejects a malformed response', async () => {
        const ns: DurableObjectNamespaceLike = {
            idFromName: () => ({}),
            get: (() => ({
                fetch: async () => ({ ok: true, status: 200, json: async () => ({ keys: 'nope', value: 5 }) })
            })) as unknown as DurableObjectNamespaceLike['get']
        };
        const store = durableObjectStore(ns);
        await expect(store.list()).rejects.toThrow(/malformed/);
        await expect(store.get('k')).rejects.toThrow(/malformed/);
    });
});

describe('TTL expiry', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('drops expired entries lazily on get and list', async () => {
        const { ns, storages } = fakeNamespace();
        const store = durableObjectStore(ns);
        await store.put('hsm:inst:short', 's', { expirationTtl: 60 });
        await store.put('hsm:inst:long', 'l', { expirationTtl: 300 });
        await store.put('hsm:inst:forever', 'f');

        vi.advanceTimersByTime(59_000);
        expect(await store.get('hsm:inst:short')).toBe('s');

        vi.advanceTimersByTime(1_000);
        expect(await store.get('hsm:inst:short')).toBeNull();
        expect((await store.list({ prefix: 'hsm:inst:' })).keys.map((k) => k.name).sort()).toEqual([
            'hsm:inst:forever',
            'hsm:inst:long'
        ]);

        vi.advanceTimersByTime(300_000);
        expect((await store.list({ prefix: 'hsm:inst:' })).keys.map((k) => k.name)).toEqual(['hsm:inst:forever']);
        // Expired entries were physically removed, not just hidden.
        expect([...storages.get('hono-status-monitor')!.data.keys()]).toEqual(['e:hsm:inst:forever']);
    });

    it('arms an alarm for the earliest expiry and purges on alarm()', async () => {
        const storage = fakeStorage();
        const obj = new StatusStoreObject({ storage }, {});
        const t0 = Date.now();

        await rpc(obj, { op: 'put', key: 'a', value: '1', ttlSeconds: 120 });
        expect(storage.alarmAt).toBe(t0 + 120_000);
        await rpc(obj, { op: 'put', key: 'b', value: '2', ttlSeconds: 60 });
        expect(storage.alarmAt).toBe(t0 + 60_000);
        await rpc(obj, { op: 'put', key: 'c', value: '3', ttlSeconds: 600 });
        expect(storage.alarmAt).toBe(t0 + 60_000); // not pushed later

        vi.advanceTimersByTime(60_000);
        await obj.alarm();
        expect([...storage.data.keys()].sort()).toEqual(['e:a', 'e:c']);
        expect(storage.alarmAt).toBe(t0 + 120_000);
    });

    it('works without alarm support', async () => {
        const { getAlarm: _g, setAlarm: _s, ...storage } = fakeStorage();
        const obj = new StatusStoreObject({ storage }, {});
        const res = await rpc(obj, { op: 'put', key: 'a', value: '1', ttlSeconds: 60 });
        expect(res.status).toBe(200);
        vi.advanceTimersByTime(61_000);
        expect(await (await rpc(obj, { op: 'get', key: 'a' })).json()).toEqual({ value: null });
    });
});

describe('StatusStoreObject validation', () => {
    const cases: [string, unknown][] = [
        ['unknown op', { op: 'delete', key: 'a' }],
        ['missing op', { key: 'a' }],
        ['non-object body', [1, 2]],
        ['non-string key on get', { op: 'get', key: 42 }],
        ['empty key', { op: 'get', key: '' }],
        ['key too long', { op: 'put', key: 'k'.repeat(DO_STORE_MAX_KEY_LENGTH + 1), value: 'v' }],
        ['non-string value', { op: 'put', key: 'a', value: { x: 1 } }],
        ['value too large', { op: 'put', key: 'a', value: 'x'.repeat(DO_STORE_MAX_VALUE_BYTES + 1) }],
        ['multi-byte value too large', { op: 'put', key: 'a', value: 'é'.repeat(DO_STORE_MAX_VALUE_BYTES / 2 + 1) }],
        ['negative ttl', { op: 'put', key: 'a', value: 'v', ttlSeconds: -1 }],
        ['string ttl', { op: 'put', key: 'a', value: 'v', ttlSeconds: '60' }],
        ['non-string prefix', { op: 'list', prefix: 1 }],
        ['prefix too long', { op: 'list', prefix: 'p'.repeat(DO_STORE_MAX_KEY_LENGTH + 1) }]
    ];

    it.each(cases)('rejects %s with 400', async (_label, body) => {
        const storage = fakeStorage();
        const res = await rpc(new StatusStoreObject({ storage }, {}), body);
        expect(res.status).toBe(400);
        expect((await res.json()) as { error: string }).toHaveProperty('error');
        expect(storage.data.size).toBe(0);
    });

    it('rejects invalid JSON and oversized bodies with 400', async () => {
        const obj = new StatusStoreObject({ storage: fakeStorage() }, {});
        expect((await rpc(obj, '{not json')).status).toBe(400);
        expect((await rpc(obj, 'x'.repeat(DO_STORE_MAX_VALUE_BYTES * 3))).status).toBe(400);
    });

    it('rejects non-POST with 405', async () => {
        const obj = new StatusStoreObject({ storage: fakeStorage() }, {});
        expect((await rpc(obj, null, 'GET')).status).toBe(405);
    });

    it('accepts a value at the size limit and a key at the length limit', async () => {
        const obj = new StatusStoreObject({ storage: fakeStorage() }, {});
        const key = 'k'.repeat(DO_STORE_MAX_KEY_LENGTH);
        const value = 'x'.repeat(DO_STORE_MAX_VALUE_BYTES);
        expect((await rpc(obj, { op: 'put', key, value })).status).toBe(200);
        expect(await (await rpc(obj, { op: 'get', key })).json()).toEqual({ value });
    });

    it('returns 500 when storage throws', async () => {
        const storage = fakeStorage();
        storage.get = async () => { throw new Error('boom'); };
        const res = await rpc(new StatusStoreObject({ storage }, {}), { op: 'get', key: 'a' });
        expect(res.status).toBe(500);
    });
});

describe('edge-store over the Durable Object store', () => {
    it('persistSnapshot + loadPeerSnapshots round trip', async () => {
        const { ns } = fakeNamespace();
        const store = durableObjectStore(ns);

        await persistSnapshot(store, 'self', snap({ totalRequests: 1 }), 120);
        await persistSnapshot(store, 'peer-1', snap({ totalRequests: 10, rps: 2 }), 120);
        await persistSnapshot(store, 'peer-2', snap({ totalRequests: 20, rps: 3 }), 120);
        await store.put('hsm:inst:junk', 'not json');

        const peers = await loadPeerSnapshots(store, 'self');
        expect(peers.map((p) => p.totalRequests).sort((a, b) => a - b)).toEqual([10, 20]);
        // maxPeers caps reads: the sorted listing is junk, peer-1, peer-2 (self excluded).
        expect((await loadPeerSnapshots(store, 'self', 2)).map((p) => p.totalRequests)).toEqual([10]);
    });

    it('persisted snapshots expire after the TTL', async () => {
        vi.useFakeTimers();
        try {
            const { ns } = fakeNamespace();
            const store = durableObjectStore(ns);
            await persistSnapshot(store, 'peer', snap({ totalRequests: 5 }), 60);
            expect(await loadPeerSnapshots(store, 'self')).toHaveLength(1);
            vi.advanceTimersByTime(60_001);
            expect(await loadPeerSnapshots(store, 'self')).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('edge-store swallows store errors', async () => {
        const ns: DurableObjectNamespaceLike = {
            idFromName: () => ({}),
            get: (() => ({ fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) })) as unknown as DurableObjectNamespaceLike['get']
        };
        const store = durableObjectStore(ns);
        await expect(persistSnapshot(store, 'a', snap({}), 60)).resolves.toBeUndefined();
        await expect(loadPeerSnapshots(store, 'a')).resolves.toEqual([]);
    });
});
