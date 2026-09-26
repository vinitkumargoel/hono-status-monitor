// =============================================================================
// HONO STATUS MONITOR - EDGE CROSS-ISOLATE AGGREGATION
// Optional persistence of per-isolate metrics into a KV/DO-shaped store so the
// dashboard can present an approximate fleet-wide view. Zero Node.js deps.
// =============================================================================

import type { MetricsSnapshot, RouteStats, StatusCodeCount, StatusStore } from './types.js';
import { round } from './metrics-utils.js';

const KEY_PREFIX = 'hsm:inst:';

/** Generate a reasonably-unique instance id (crypto when available). */
export function generateInstanceId(): string {
    try {
        const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
        if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    } catch {
        /* fall through */
    }
    // Fallback: time + non-crypto entropy. Uniqueness across isolates is best-effort.
    return `i-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Persist a snapshot for this instance. Never throws (best-effort). */
export async function persistSnapshot(
    store: StatusStore,
    instanceId: string,
    snapshot: MetricsSnapshot,
    ttlSeconds: number
): Promise<void> {
    try {
        await store.put(
            `${KEY_PREFIX}${instanceId}`,
            JSON.stringify(snapshot),
            // KV requires a minimum TTL of 60s; clamp to be safe.
            { expirationTtl: Math.max(60, Math.floor(ttlSeconds)) }
        );
    } catch {
        /* best-effort; ignore store errors */
    }
}

/**
 * Minimal shape check for a peer snapshot read back from the store. Guards the
 * merge against malformed/foreign entries sharing the key prefix (a stray write,
 * a schema change across a rolling deploy) so one bad record can't poison the
 * aggregate — arithmetic below assumes these fields are numbers/objects.
 */
function isValidSnapshot(v: unknown): v is MetricsSnapshot {
    if (!v || typeof v !== 'object') return false;
    const s = v as Record<string, unknown>;
    const count = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
    const optionalArray = (x: unknown) => x === undefined || Array.isArray(x);
    return (
        count(s.totalRequests) &&
        count(s.rps) &&
        typeof s.statusCodes === 'object' &&
        s.statusCodes !== null &&
        !Array.isArray(s.statusCodes) &&
        optionalArray(s.topRoutes) &&
        optionalArray(s.slowestRoutes) &&
        optionalArray(s.errorRoutes) &&
        optionalArray(s.recentErrors)
    );
}

/**
 * Load peer snapshots (excluding this instance), at most `maxPeers` of them so
 * a large fleet can't turn one dashboard read into hundreds of KV reads.
 * Never throws.
 */
export async function loadPeerSnapshots(
    store: StatusStore,
    excludeInstanceId: string,
    maxPeers = Infinity
): Promise<MetricsSnapshot[]> {
    const ownKey = `${KEY_PREFIX}${excludeInstanceId}`;
    const parse = (raw: string | null): MetricsSnapshot | null => {
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw) as unknown;
            return isValidSnapshot(parsed) ? parsed : null;
        } catch {
            return null;
        }
    };
    try {
        if (store.entries) {
            const entries = await store.entries({ prefix: KEY_PREFIX });
            return entries
                .filter((e) => e.name !== ownKey)
                .slice(0, maxPeers)
                .map((e) => parse(e.value))
                .filter((p): p is MetricsSnapshot => p !== null);
        }
        const listing = await store.list({ prefix: KEY_PREFIX });
        const peers = await Promise.all(
            listing.keys
                .filter((k) => k.name !== ownKey)
                .slice(0, maxPeers)
                .map(async (k) => {
                    try {
                        return parse(await store.get(k.name));
                    } catch {
                        return null;
                    }
                })
        );
        return peers.filter((p): p is MetricsSnapshot => p !== null);
    } catch {
        return [];
    }
}

function mergeRoutes(all: RouteStats[]): Map<string, RouteStats> {
    const map = new Map<string, RouteStats>();
    // Dedupe per source list already handled by callers; here we sum across instances.
    for (const route of all) {
        const key = `${route.method}:${route.path}`;
        const existing = map.get(key);
        if (existing) {
            existing.count += route.count;
            existing.totalTime += route.totalTime;
            existing.avgTime = existing.count > 0 ? existing.totalTime / existing.count : 0;
            existing.minTime = Math.min(existing.minTime, route.minTime);
            existing.maxTime = Math.max(existing.maxTime, route.maxTime);
            existing.errors += route.errors;
            existing.lastAccess = Math.max(existing.lastAccess, route.lastAccess);
        } else {
            map.set(key, { ...route });
        }
    }
    return map;
}

function dedupePerSnapshot(s: MetricsSnapshot): RouteStats[] {
    // topRoutes/slowestRoutes/errorRoutes overlap; keep one entry per key per snapshot.
    const seen = new Map<string, RouteStats>();
    for (const r of [...(s.topRoutes || []), ...(s.slowestRoutes || []), ...(s.errorRoutes || [])]) {
        seen.set(`${r.method}:${r.path}`, r);
    }
    return [...seen.values()];
}

/**
 * Merge this instance's snapshot with peer snapshots into an approximate
 * fleet-wide view. Pure function — safe to unit test.
 *
 * @param limits.maxRoutes        cap for top/slowest/error route lists (default 10)
 * @param limits.maxRecentErrors  cap for the merged recent-error list (default 10)
 *
 * Counts (rps, totalRequests, activeConnections, statusCodes) are summed. Rates
 * are weighted by traffic so an idle isolate can't drag the fleet figure
 * around: responseTime by each isolate's rps, errorRate by its totalRequests
 * (which makes it exact). With no traffic anywhere they fall back to a plain
 * mean.
 */
export function mergeSnapshots(
    base: MetricsSnapshot,
    peers: MetricsSnapshot[],
    limits: { maxRoutes?: number; maxRecentErrors?: number } = {}
): MetricsSnapshot {
    const maxRoutes = limits.maxRoutes ?? 10;
    const maxRecentErrors = limits.maxRecentErrors ?? 10;

    if (peers.length === 0) {
        return { ...base, instanceCount: 1 };
    }

    const all = [base, ...peers];
    const instanceCount = all.length;

    let totalRps = 0;
    let totalRequests = 0;
    let totalActiveConnections = 0;
    let sumResponseTime = 0;
    let sumErrorRate = 0;
    let weightedResponseTime = 0;
    let weightedErrorRate = 0;

    const statusCodes: StatusCodeCount = {};
    let rateLimitBlocked = 0;
    let rateLimitTotal = 0;
    const routeInputs: RouteStats[] = [];
    const recentErrors: MetricsSnapshot['recentErrors'] = [];

    for (const s of all) {
        totalRps += s.rps || 0;
        totalRequests += s.totalRequests || 0;
        totalActiveConnections += s.activeConnections || 0;
        sumResponseTime += s.responseTime || 0;
        sumErrorRate += s.errorRate || 0;
        weightedResponseTime += (s.responseTime || 0) * (s.rps || 0);
        weightedErrorRate += (s.errorRate || 0) * (s.totalRequests || 0);

        for (const [code, count] of Object.entries(s.statusCodes || {})) {
            if (typeof count === 'number' && Number.isFinite(count)) {
                statusCodes[code] = (statusCodes[code] || 0) + count;
            }
        }
        rateLimitBlocked += s.rateLimitStats?.blocked || 0;
        rateLimitTotal += s.rateLimitStats?.total || 0;

        routeInputs.push(...dedupePerSnapshot(s));
        if (s.recentErrors) recentErrors.push(...s.recentErrors);
    }

    const routes = [...mergeRoutes(routeInputs).values()];
    const topRoutes = [...routes].sort((a, b) => b.count - a.count).slice(0, maxRoutes);
    const slowestRoutes = routes.filter((r) => r.count > 0).sort((a, b) => b.avgTime - a.avgTime).slice(0, maxRoutes);
    const errorRoutes = routes.filter((r) => r.errors > 0).sort((a, b) => b.errors - a.errors).slice(0, maxRoutes);

    return {
        ...base,
        rps: round(totalRps),
        totalRequests,
        activeConnections: totalActiveConnections,
        responseTime: round(totalRps > 0 ? weightedResponseTime / totalRps : sumResponseTime / instanceCount),
        errorRate: round(totalRequests > 0 ? weightedErrorRate / totalRequests : sumErrorRate / instanceCount),
        statusCodes,
        rateLimitStats: { blocked: rateLimitBlocked, total: rateLimitTotal },
        topRoutes,
        slowestRoutes,
        errorRoutes,
        recentErrors: recentErrors.sort((a, b) => b.timestamp - a.timestamp).slice(0, maxRecentErrors),
        instanceCount
    };
}
