// =============================================================================
// HONO STATUS MONITOR - DURABLE OBJECT STORE
// A strongly consistent StatusStore backed by a single Cloudflare Durable
// Object. Structural types only: no dependency on @cloudflare/workers-types and
// no Node.js imports.
// =============================================================================

import type { StatusStore } from './types.js';

/** The subset of `DurableObjectStorage` this module uses. */
export interface DurableObjectStorageLike {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string | string[]): Promise<boolean | number>;
    list(options?: { prefix?: string }): Promise<Map<string, unknown>>;
    getAlarm?(): Promise<number | null>;
    setAlarm?(scheduledTime: number): Promise<void>;
}

/** The subset of `DurableObjectState` this module uses. */
export interface DurableObjectStateLike {
    storage: DurableObjectStorageLike;
}

/** The subset of a `Response` the client reads. */
export interface DurableObjectResponseLike {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
}

/** The subset of `DurableObjectStub` the client uses. */
export interface DurableObjectStubLike {
    fetch(
        input: string,
        init: { method: string; headers?: Record<string, string>; body: string }
    ): Promise<DurableObjectResponseLike>;
}

/** The subset of `DurableObjectNamespace` the client uses. */
export interface DurableObjectNamespaceLike {
    idFromName(name: string): unknown;
    get(id: never): DurableObjectStubLike;
}

/** Longest accepted key or prefix, in characters. */
export const DO_STORE_MAX_KEY_LENGTH = 512;
/** Largest accepted value, in UTF-8 bytes. */
export const DO_STORE_MAX_VALUE_BYTES = 128 * 1024;
/** Longest accepted TTL (30 days); snapshots are rewritten every storeWriteInterval anyway. */
export const DO_STORE_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Largest accepted request body, in characters (value plus JSON overhead). */
const MAX_BODY_CHARS = DO_STORE_MAX_VALUE_BYTES * 2 + 4096;
/** Internal storage-key prefix, so the purge only ever touches our entries. */
const ENTRY_PREFIX = 'e:';

interface Entry {
    v: string;
    /** Expiry as epoch ms, or null for no expiry. */
    e: number | null;
}

type RpcRequest =
    | { op: 'get'; key: string }
    | { op: 'put'; key: string; value: string; ttlSeconds?: number }
    | { op: 'list'; prefix?: string; withValues?: boolean };

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
}

function isEntry(v: unknown): v is Entry {
    if (!v || typeof v !== 'object') return false;
    const e = v as Record<string, unknown>;
    return typeof e.v === 'string' && (e.e === null || typeof e.e === 'number');
}

function isExpired(entry: Entry, now: number): boolean {
    return entry.e !== null && entry.e <= now;
}

function utf8Length(s: string): number {
    return new TextEncoder().encode(s).byteLength;
}

function isValidKey(k: unknown): k is string {
    return typeof k === 'string' && k.length > 0 && k.length <= DO_STORE_MAX_KEY_LENGTH;
}

/** Validate a decoded RPC body. Returns the request or an error message. */
function parseRpc(body: unknown): RpcRequest | string {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
    const b = body as Record<string, unknown>;
    switch (b.op) {
        case 'get':
            if (!isValidKey(b.key)) return `key must be a non-empty string of at most ${DO_STORE_MAX_KEY_LENGTH} chars`;
            return { op: 'get', key: b.key };
        case 'put': {
            if (!isValidKey(b.key)) return `key must be a non-empty string of at most ${DO_STORE_MAX_KEY_LENGTH} chars`;
            if (typeof b.value !== 'string') return 'value must be a string';
            if (utf8Length(b.value) > DO_STORE_MAX_VALUE_BYTES) {
                return `value exceeds ${DO_STORE_MAX_VALUE_BYTES} bytes`;
            }
            const ttl = b.ttlSeconds;
            if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0 || ttl > DO_STORE_MAX_TTL_SECONDS)) {
                return `ttlSeconds must be a positive number of at most ${DO_STORE_MAX_TTL_SECONDS}`;
            }
            return { op: 'put', key: b.key, value: b.value, ttlSeconds: ttl };
        }
        case 'list':
            if (b.prefix !== undefined && (typeof b.prefix !== 'string' || b.prefix.length > DO_STORE_MAX_KEY_LENGTH)) {
                return `prefix must be a string of at most ${DO_STORE_MAX_KEY_LENGTH} chars`;
            }
            if (b.withValues !== undefined && typeof b.withValues !== 'boolean') return 'withValues must be a boolean';
            return { op: 'list', prefix: b.prefix, withValues: b.withValues };
        default:
            return 'op must be one of get, put, list';
    }
}

/**
 * Durable Object backing {@link durableObjectStore}. Re-export it from your
 * Worker entry and bind it in wrangler.toml (see docs/durable-object-store.md).
 *
 * Entries carry an expiry timestamp. Expired entries are dropped lazily on
 * get/list, and an alarm (when the runtime supports it) purges the rest.
 */
export class StatusStoreObject {
    private readonly storage: DurableObjectStorageLike;

    constructor(state: DurableObjectStateLike, _env?: unknown) {
        this.storage = state.storage;
    }

    async fetch(request: Request): Promise<Response> {
        if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

        let text: string;
        try {
            text = await request.text();
        } catch {
            return json({ error: 'unreadable body' }, 400);
        }
        if (text.length > MAX_BODY_CHARS) return json({ error: 'body too large' }, 400);

        let body: unknown;
        try {
            body = JSON.parse(text);
        } catch {
            return json({ error: 'invalid JSON' }, 400);
        }

        const rpc = parseRpc(body);
        if (typeof rpc === 'string') return json({ error: rpc }, 400);

        try {
            switch (rpc.op) {
                case 'get':
                    return json({ value: await this.get(rpc.key) });
                case 'put':
                    await this.put(rpc.key, rpc.value, rpc.ttlSeconds);
                    return json({ ok: true });
                case 'list': {
                    const entries = await this.list(rpc.prefix ?? '');
                    return json(rpc.withValues ? { entries } : { keys: entries.map(({ name }) => ({ name })) });
                }
            }
        } catch {
            return json({ error: 'storage error' }, 500);
        }
    }

    /** Alarm handler: purge expired entries, then re-arm for the next expiry. */
    async alarm(): Promise<void> {
        const now = Date.now();
        const entries = await this.storage.list({ prefix: ENTRY_PREFIX });
        const expired: string[] = [];
        let next: number | null = null;
        for (const [storageKey, entry] of entries) {
            if (!isEntry(entry)) {
                expired.push(storageKey);
            } else if (isExpired(entry, now)) {
                expired.push(storageKey);
            } else if (entry.e !== null && (next === null || entry.e < next)) {
                next = entry.e;
            }
        }
        await this.deleteKeys(expired);
        if (next !== null && this.storage.setAlarm) await this.storage.setAlarm(next);
    }

    private async get(key: string): Promise<string | null> {
        const storageKey = ENTRY_PREFIX + key;
        const entry = await this.storage.get(storageKey);
        if (!isEntry(entry)) return null;
        if (isExpired(entry, Date.now())) {
            await this.storage.delete(storageKey);
            return null;
        }
        return entry.v;
    }

    private async put(key: string, value: string, ttlSeconds?: number): Promise<void> {
        const expiresAt = ttlSeconds === undefined ? null : Date.now() + Math.ceil(ttlSeconds * 1000);
        const entry: Entry = { v: value, e: expiresAt };
        await this.storage.put(ENTRY_PREFIX + key, entry);
        if (expiresAt !== null) await this.scheduleAlarm(expiresAt);
    }

    /** Live entries under `prefix`. Storage returns values with the keys, so they come along for free. */
    private async list(prefix: string): Promise<{ name: string; value: string }[]> {
        const now = Date.now();
        const entries = await this.storage.list({ prefix: ENTRY_PREFIX + prefix });
        const keys: { name: string; value: string }[] = [];
        const expired: string[] = [];
        for (const [storageKey, entry] of entries) {
            if (!isEntry(entry) || isExpired(entry, now)) {
                expired.push(storageKey);
            } else {
                keys.push({ name: storageKey.slice(ENTRY_PREFIX.length), value: entry.v });
            }
        }
        await this.deleteKeys(expired);
        return keys;
    }

    private async deleteKeys(keys: string[]): Promise<void> {
        // DO storage deletes at most 128 keys per call.
        for (let i = 0; i < keys.length; i += 128) {
            await this.storage.delete(keys.slice(i, i + 128));
        }
    }

    /** Arm the alarm for `at` unless one is already due sooner. */
    private async scheduleAlarm(at: number): Promise<void> {
        const { getAlarm, setAlarm } = this.storage;
        if (!getAlarm || !setAlarm) return;
        const current = await getAlarm.call(this.storage);
        if (current === null || current > at) await setAlarm.call(this.storage, at);
    }
}

async function call(namespace: DurableObjectNamespaceLike, name: string, payload: object): Promise<unknown> {
    // A fresh stub per call: stubs are cheap, and one that saw an exception
    // (e.g. the object was reset by a deploy) can stay broken if reused.
    const stub = namespace.get(namespace.idFromName(name) as never);
    const res = await stub.fetch('https://status-store/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`StatusStoreObject responded ${res.status}`);
    return res.json();
}

/**
 * A {@link StatusStore} backed by a single named {@link StatusStoreObject}
 * instance. Strongly consistent, unlike Workers KV. Errors reject; the monitor
 * treats store errors as best-effort.
 *
 * @param namespace the Durable Object namespace binding (e.g. `env.STATUS_STORE`)
 * @param name      which object instance to use (default `'hono-status-monitor'`)
 */
export function durableObjectStore(namespace: DurableObjectNamespaceLike, name = 'hono-status-monitor'): StatusStore {
    return {
        async get(key) {
            const res = (await call(namespace, name, { op: 'get', key })) as { value?: unknown } | null;
            const value = res?.value;
            if (value === null || value === undefined) return null;
            if (typeof value !== 'string') throw new Error('StatusStoreObject returned a malformed value');
            return value;
        },
        async put(key, value, options) {
            await call(namespace, name, { op: 'put', key, value, ttlSeconds: options?.expirationTtl });
        },
        async list(options) {
            const res = (await call(namespace, name, { op: 'list', prefix: options?.prefix })) as {
                keys?: unknown;
            } | null;
            const keys = res?.keys;
            if (!Array.isArray(keys)) throw new Error('StatusStoreObject returned a malformed listing');
            return {
                keys: keys
                    .filter((k): k is { name: string } => !!k && typeof (k as { name?: unknown }).name === 'string')
                    .map((k) => ({ name: k.name }))
            };
        },
        // One round trip for the whole peer set instead of list + one get per peer.
        async entries(options) {
            const res = (await call(namespace, name, { op: 'list', prefix: options?.prefix, withValues: true })) as {
                entries?: unknown;
            } | null;
            const entries = res?.entries;
            if (!Array.isArray(entries)) throw new Error('StatusStoreObject returned a malformed listing');
            return entries.filter((e): e is { name: string; value: string } =>
                !!e && typeof (e as { name?: unknown }).name === 'string' && typeof (e as { value?: unknown }).value === 'string');
        }
    };
}
