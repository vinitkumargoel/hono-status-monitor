// =============================================================================
// SMOKE TEST - THE BUILT PACKAGE, AS A CONSUMER SEES IT
//
// Imports `hono-status-monitor` and `hono-status-monitor/edge` by package name,
// so resolution goes through the `exports` map and lands on dist/ — not src/,
// which is all the unit tests exercise. Run from the repo (self-reference) or
// from a scratch project with the packed tarball installed (what CI does).
// Plain JS with no test runner so it also runs on Node 18 and Bun.
// =============================================================================

import { Hono } from 'hono';
import * as main from 'hono-status-monitor';
import * as edge from 'hono-status-monitor/edge';

const failures = [];
const check = (label, ok) => {
    if (!ok) failures.push(label);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
};

console.log = ((log) => (...args) => {
    // Silence the monitor's own start/stop chatter; keep ours.
    if (typeof args[0] === 'string' && args[0].startsWith('📊')) return;
    log(...args);
})(console.log);

for (const [name, mod] of [['main', main], ['edge', edge]]) {
    const monitor = mod.statusMonitor({
        path: '/status',
        securityHeaders: true,
        healthChecks: { self: async () => ({ connected: true, latencyMs: 0 }) }
    });
    const app = new Hono();
    app.use('*', monitor.middleware);
    app.route('/status', monitor.routes);
    app.get('/', (c) => c.text('hi'));
    app.get('/fail', (c) => c.text('no', 500));

    await app.request('/');
    await app.request('/fail');

    const page = await app.request('/status');
    const html = await page.text();
    check(`${name}: dashboard renders`, page.status === 200 && html.includes('id="connBadge"'));
    check(`${name}: dashboard sends a CSP with a matching nonce`, (() => {
        const nonce = /'nonce-([^']+)'/.exec(page.headers.get('content-security-policy') ?? '')?.[1];
        return !!nonce && html.includes(`<script nonce="${nonce}">`);
    })());

    const api = await (await app.request('/status/api/metrics')).json();
    check(`${name}: /api/metrics counts traffic`, api.snapshot.totalRequests === 2);
    check(`${name}: /api/metrics carries health`, Array.isArray(api.health?.checks));

    const health = await app.request('/status/health');
    check(`${name}: /health is 200`, health.status === 200);

    const prom = await (await app.request('/status/prometheus')).text();
    check(`${name}: /prometheus exposes counters`, prom.includes('hono_requests_total 2'));

    monitor.stop();
}

check('main entry keeps Node-only exports', typeof main.createMonitor === 'function');
check('edge entry has no Node-only exports', !('createMonitor' in edge));

if (failures.length) {
    console.error(`\n${failures.length} smoke check(s) failed`);
    process.exit(1);
}
console.log('\nsmoke: all checks passed');
