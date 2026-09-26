// =============================================================================
// DASHBOARD CONTRACT
//
// One client script drives both the Node and edge dashboards. It tolerates a
// missing DOM element (the two variants render different cards) but a missing
// *field* used to throw inside the fetch handler, where the catch would swallow
// it and silently freeze every card on the page.
//
// The script is now value-safe too, so a gap degrades to an em dash instead of
// a freeze. These tests pin both halves: the fields each platform is expected to
// report, and the script's tolerance of a snapshot that lacks them.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { createMonitor } from '../src/monitor';
import { createEdgeMonitor } from '../src/monitor-edge';
import { clientScript } from '../src/dashboard-assets';

/** Top-level numeric snapshot fields the client script formats. */
const NUMERIC_FIELDS = [
    'cpu', 'memoryMB', 'heapUsedMB', 'heapTotalMB', 'loadAvg', 'responseTime',
    'rps', 'eventLoopLag', 'errorRate', 'processUptime', 'totalRequests',
    'activeConnections'
];

/** Nested objects the script reads through. */
const OBJECT_FIELDS = ['percentiles', 'statusCodes', 'rateLimitStats', 'alerts'];

/** Array fields the script iterates. */
const ARRAY_FIELDS = ['topRoutes', 'slowestRoutes', 'errorRoutes', 'recentErrors'];

describe('dashboard snapshot contract', () => {
    for (const [platform, make] of [
        ['node', () => createMonitor({})],
        ['edge', () => createEdgeMonitor({})]
    ] as const) {
        it(`${platform} snapshot supplies every field the shared script reads`, async () => {
            const monitor = make();
            monitor.trackRequest('/x', 'GET');
            monitor.trackRequestComplete('/x', 'GET', 7, 200);
            const snapshot = (await monitor.getMetricsSnapshot()) as unknown as Record<string, unknown>;
            monitor.stop();

            for (const key of NUMERIC_FIELDS) {
                expect(typeof snapshot[key], `${platform}.${key}`).toBe('number');
                expect(Number.isFinite(snapshot[key] as number), `${platform}.${key} finite`).toBe(true);
            }
            for (const key of OBJECT_FIELDS) {
                expect(snapshot[key], `${platform}.${key}`).toBeTypeOf('object');
                expect(snapshot[key], `${platform}.${key}`).not.toBeNull();
            }
            for (const key of ARRAY_FIELDS) {
                expect(Array.isArray(snapshot[key]), `${platform}.${key} is array`).toBe(true);
            }

            const pct = snapshot.percentiles as Record<string, number>;
            for (const key of ['avg', 'p50', 'p95', 'p99']) {
                expect(typeof pct[key], `${platform}.percentiles.${key}`).toBe('number');
            }
        });
    }

    it('script degrades to an em dash rather than throwing on an empty snapshot', () => {
        const script = clientScript(true, 1000);

        // Drive the script's formatters directly against a snapshot with nothing
        // in it — the shape a future "trim the edge payload" change would produce.
        const setNum = new Function(`${extract(script, 'setNum')} return setNum;`)();
        const fx = new Function(`${extract(script, 'fx')} return fx;`)();
        const formatUptime = new Function(`${extract(script, 'formatUptime')} return formatUptime;`)();

        const el = { textContent: '' };
        (globalThis as any).document = { getElementById: () => el };
        try {
            expect(() => setNum('anything', undefined, 1)).not.toThrow();
            expect(el.textContent).toBe('—');
            setNum('anything', 12.34, 1, 'ms');
            expect(el.textContent).toBe('12.3ms');
        } finally {
            delete (globalThis as any).document;
        }

        expect(fx(undefined, 1)).toBe('—');
        expect(fx(1.25, 1)).toBe('1.3');
        expect(formatUptime(undefined)).toBe('—');
        expect(formatUptime(61)).toBe('1m 1s');
    });
});

/** Pull a single `function name(...) { ... }` declaration out of the script text. */
function extract(script: string, name: string): string {
    const start = script.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`${name}() not found in client script`);
    let depth = 0;
    for (let i = script.indexOf('{', start); i < script.length; i++) {
        if (script[i] === '{') depth++;
        else if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
    }
    throw new Error(`unterminated ${name}()`);
}
