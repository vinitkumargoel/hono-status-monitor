// =============================================================================
// BUNDLE SIZE BUDGET
// Bundles each public entry the way a consumer's bundler would (hono external,
// minified, tree-shaken) and fails if it outgrows its budget. Keeps the 1.1.0
// size work from regressing silently.
// =============================================================================

import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

/** Minified bytes: 1.2.0 sizes plus ~7% headroom. */
const BUDGETS = [
    { entry: 'dist/index.js', label: 'main', max: 72_000 },
    { entry: 'dist/index-edge.js', label: 'edge', max: 51_000 }
];

let failed = false;
for (const { entry, label, max } of BUDGETS) {
    const result = await build({
        entryPoints: [entry],
        bundle: true,
        minify: true,
        format: 'esm',
        platform: label === 'edge' ? 'neutral' : 'node',
        external: ['hono', 'hono/*'],
        write: false,
        logLevel: 'silent'
    });
    const code = result.outputFiles[0].contents;
    const gz = gzipSync(code).length;
    const ok = code.length <= max;
    failed ||= !ok;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(5)} ${code.length.toLocaleString()} B minified, ${gz.toLocaleString()} B gzip (budget ${max.toLocaleString()} B)`);
}
if (failed) process.exit(1);
