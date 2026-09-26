// @vitest-environment node
// Runs the real dashboard client script in jsdom against a scripted fetch, so
// the browser half of the dashboard is tested, not just the HTML it ships in.
import { describe, it, expect } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { generateDashboard } from '../src/dashboard';
import { generateEdgeDashboard } from '../src/dashboard-edge';

type Reply = { status: number; body?: unknown } | 'hang';

const snapshot = (over: Record<string, unknown> = {}) => ({
    cpu: 12.34, memoryMB: 100, heapUsedMB: 5, heapTotalMB: 10, loadAvg: 0.5, responseTime: 7, rps: 3,
    eventLoopLag: 1, errorRate: 25, processUptime: 61, totalRequests: 1234, activeConnections: 2,
    percentiles: { p50: 1, p95: 2, p99: 3, avg: 1.5 }, statusCodes: { '200': 3, '404': 1 },
    rateLimitStats: { blocked: 0, total: 0 }, alerts: { errorRate: true },
    topRoutes: Array.from({ length: 8 }, (_, i) => ({ method: 'GET', path: `/r${i}`, count: 10 - i, avgTime: 1, errors: 0 })),
    slowestRoutes: [], errorRoutes: [], recentErrors: [], platform: 'Linux 6', nodeVersion: 'v22', pid: 1, cpuCount: 4,
    ...over
});

/** Minimal EventSource stand-in the test drives by hand. */
class FakeEventSource {
    static instances: FakeEventSource[] = [];
    readyState = 0;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) { FakeEventSource.instances.push(this); }
    close() { this.readyState = 2; }
    emit(body: unknown) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify(body) }); }
}

async function boot(html: string, replies: Reply[], opts: { eventSource?: boolean } = {}) {
    const calls: string[] = [];
    const virtualConsole = new VirtualConsole(); // swallow the script's console noise
    const dom = new JSDOM(html, {
        url: 'http://localhost/status',
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        virtualConsole,
        beforeParse(window) {
            (window.HTMLCanvasElement.prototype as unknown as { getContext: () => null }).getContext = () => null;
            if (opts.eventSource) {
                FakeEventSource.instances = [];
                (window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
                // Shrink the 5 s first-frame watchdog so the test doesn't wait for it.
                const realSetTimeout = window.setTimeout.bind(window);
                (window as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void, ms?: number) =>
                    realSetTimeout(fn, ms === 5000 ? 30 : ms);
            }
            (window as unknown as { fetch: unknown }).fetch = (url: string) => {
                calls.push(url);
                const reply = replies.shift() ?? { status: 200, body: { snapshot: snapshot(), charts: {} } };
                if (reply === 'hang') return new Promise(() => {});
                return Promise.resolve({ ok: reply.status < 400, status: reply.status, json: async () => reply.body });
            };
        }
    });
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    const $ = (id: string) => dom.window.document.getElementById(id);
    return { dom, $, calls, settle };
}

const html = (over: Parameters<typeof generateDashboard>[0] extends infer P ? Partial<P> : never = {}) =>
    generateDashboard({ title: 'T', hostname: 'h', uptime: '1s', inlineCharts: true, pollingInterval: 60_000, ...over });

describe('dashboard client script', () => {
    it('renders a snapshot into the cards and marks the badge Live', async () => {
        const { $, dom } = await boot(html(), [{ status: 200, body: { snapshot: snapshot(), charts: {} } }]);
        expect($('connText')!.textContent).toBe('Live');
        expect($('cpuVal')!.textContent).toBe('12.3');
        expect($('totalReq')!.textContent).toBe((1234).toLocaleString());
        expect($('s2xx')!.textContent).toBe('3');
        expect($('s4xx')!.textContent).toBe('1');
        expect($('alertsLive')!.textContent).toBe('Alert: Error rate above threshold');
        dom.window.close();
    });

    it('limits route lists to maxRoutes and titles truncated paths', async () => {
        const { $, dom } = await boot(html({ maxRoutes: 3 }), []);
        const rows = $('topRoutes')!.querySelectorAll('.route-path');
        expect(rows).toHaveLength(3);
        expect(rows[0].getAttribute('title')).toBe('GET /r0');
        dom.window.close();
    });

    it('shows Unauthorized on 401 and backs off instead of hammering', async () => {
        const { $, dom, calls } = await boot(html(), [{ status: 401 }]);
        expect($('connText')!.textContent).toBe('Unauthorized');
        expect($('connBadge')!.className).toBe('status-badge down');
        expect(calls).toHaveLength(1);
        dom.window.close();
    });

    it('renders one card per health check, or says none are configured', async () => {
        const health = { configured: true, checks: [{ name: 'db', connected: true, latencyMs: 2 }, { name: '<b>x</b>', connected: false, latencyMs: 0 }] };
        const withChecks = await boot(html(), [{ status: 200, body: { snapshot: snapshot(), charts: {}, health } }]);
        const cards = withChecks.$('healthList')!.querySelectorAll('.health-item');
        expect(cards).toHaveLength(2);
        expect(cards[1].querySelector('.label')!.textContent).toBe('<b>x</b>'); // escaped, not markup
        expect(cards[1].querySelector('.status')!.textContent).toBe('Down');
        withChecks.dom.window.close();

        const without = await boot(html(), []);
        expect(without.$('healthList')!.textContent).toBe('No health checks configured');
        without.dom.window.close();
    });

    it('toggles the theme and reflects it in aria-pressed', async () => {
        const { $, dom } = await boot(html(), []);
        const btn = $('themeToggle')!;
        const before = dom.window.document.documentElement.classList.contains('dark');
        btn.dispatchEvent(new dom.window.MouseEvent('click'));
        expect(dom.window.document.documentElement.classList.contains('dark')).toBe(!before);
        expect(btn.getAttribute('aria-pressed')).toBe(String(!before));
        dom.window.close();
    });

    it('offers only the time ranges the server retains', async () => {
        const short = await boot(html({ retentionSeconds: 60 }), []);
        expect(short.$('rangeSelect')!.hidden).toBe(true);
        short.dom.window.close();
        const long = await boot(html({ retentionSeconds: 900 }), []);
        expect([...long.$('rangeSelect')!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['1m', '5m', '15m']);
        long.dom.window.close();
    });

    describe('live stream (SSE)', () => {
        const streamed = () => html({ stream: true, pollingInterval: 1000 });
        const setHidden = (dom: JSDOM, hidden: boolean) => {
            Object.defineProperty(dom.window.document, 'hidden', { configurable: true, get: () => hidden });
            dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
        };

        it('renders pushed frames without polling', async () => {
            const { $, dom, calls } = await boot(streamed(), [], { eventSource: true });
            expect(FakeEventSource.instances).toHaveLength(1);
            expect(FakeEventSource.instances[0].url).toContain('api/stream');
            FakeEventSource.instances[0].emit({ snapshot: snapshot(), charts: {} });
            expect($('connText')!.textContent).toBe('Live');
            expect($('cpuVal')!.textContent).toBe('12.3');
            expect(calls).toHaveLength(0);
            dom.window.close();
        });

        it('falls back to polling when the stream opens but never delivers a frame', async () => {
            const { dom, calls, settle } = await boot(streamed(), [], { eventSource: true });
            await settle();
            await settle();
            expect(FakeEventSource.instances[0].readyState).toBe(2);
            expect(calls.length).toBeGreaterThanOrEqual(1);
            dom.window.close();
        });

        it('re-arms the watchdog when the stream reconnects after the tab was hidden', async () => {
            const { dom, calls, settle } = await boot(streamed(), [], { eventSource: true });
            FakeEventSource.instances[0].emit({ snapshot: snapshot(), charts: {} });
            setHidden(dom, true);
            expect(FakeEventSource.instances[0].readyState).toBe(2);
            setHidden(dom, false);
            expect(FakeEventSource.instances).toHaveLength(2);
            await settle();
            await settle();
            // The second connection stalled silently; the dashboard must not freeze on it.
            expect(FakeEventSource.instances[1].readyState).toBe(2);
            expect(calls.length).toBeGreaterThanOrEqual(1);
            dom.window.close();
        });

        it('falls back to polling when the server refuses the stream', async () => {
            const { dom, calls } = await boot(streamed(), [], { eventSource: true });
            const es = FakeEventSource.instances[0];
            es.readyState = 2;
            es.onerror?.();
            await new Promise((r) => setTimeout(r, 20));
            expect(calls).toHaveLength(1);
            dom.window.close();
        });
    });

    it('drives the edge dashboard with the same script', async () => {
        const { $, dom } = await boot(generateEdgeDashboard({ title: 'T', hostname: 'h', uptime: '1s', inlineCharts: true }), []);
        expect($('connText')!.textContent).toBe('Live');
        expect($('rtVal')!.textContent).toBe('7.0');
        dom.window.close();
    });
});
