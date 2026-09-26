// =============================================================================
// SMOKE TEST - THE /edge BUILD INSIDE THE REAL CLOUDFLARE WORKERS RUNTIME
//
// Bundles a Worker that imports the package by its main name, with the
// conditions Wrangler uses (so the `workerd` export condition must pick the
// edge build), and runs it in workerd through Miniflare, with a KV namespace
// as the cross-isolate store. Needs `miniflare`, which isn't a dependency:
//   npm install --no-save miniflare@4 && npm run build && node scripts/workerd-smoke.mjs
// =============================================================================

import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const worker = `
import { Hono } from 'hono';
import { statusMonitor } from 'hono-status-monitor';

let monitor;
export default {
    fetch(req, env, ctx) {
        monitor ??= statusMonitor({ publicAccess: true, store: env.STATUS_KV, storeWriteInterval: 1000, groupBy: 'route', prometheusHistogram: true, logger: false,
            healthChecks: { kv: async () => ({ connected: !!env.STATUS_KV, latencyMs: 0 }) } });
        const app = new Hono();
        app.use('*', monitor.middleware);
        app.route('/status', monitor.routes);
        app.get('/users/:id', (c) => c.text('user ' + c.req.param('id')));
        return app.fetch(req, env, ctx);
    }
};`;

const { outputFiles } = await build({
    stdin: { contents: worker, resolveDir: process.cwd(), loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser'],
    write: false,
    logLevel: 'error'
});
const script = outputFiles[0].text;
if (/from\s*["']node:/.test(script)) throw new Error('edge bundle imports a node: builtin');

const mf = new Miniflare({ modules: true, script, compatibilityDate: '2025-01-01', kvNamespaces: ['STATUS_KV'] });
const failures = [];
const check = (label, ok) => {
    if (!ok) failures.push(label);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
};

try {
    for (const id of [1, 2, 3]) await mf.dispatchFetch(`http://w/users/${id}`);
    const page = await mf.dispatchFetch('http://w/status');
    check('dashboard renders in workerd', page.status === 200 && (await page.text()).includes('id="connBadge"'));

    const api = await (await mf.dispatchFetch('http://w/status/api/metrics')).json();
    check('requests are counted', api.snapshot.totalRequests === 3);
    check('routes group by pattern', api.snapshot.topRoutes[0]?.path === '/users/:id' && api.snapshot.topRoutes[0]?.count === 3);
    check('health report included', api.health?.checks?.[0]?.name === 'kv');
    check('labelled as Cloudflare Workers', api.snapshot.platform === 'Cloudflare Workers');

    const health = await mf.dispatchFetch('http://w/status/health');
    check('/health is 200', health.status === 200);

    const prom = await (await mf.dispatchFetch('http://w/status/prometheus')).text();
    check('/prometheus has the latency histogram', prom.includes('route="/users/:id"'));

    const kv = await mf.getKVNamespace('STATUS_KV');
    const keys = (await kv.list({ prefix: 'hsm:inst:' })).keys;
    check('isolate persisted itself to KV from the request path', keys.length === 1);
} finally {
    await mf.dispose();
}

if (failures.length) {
    console.error(`\n${failures.length} workerd check(s) failed`);
    process.exit(1);
}
console.log('\nworkerd smoke: all checks passed');
