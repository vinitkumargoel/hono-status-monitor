// =============================================================================
// BUILD STEP - MINIFY EMBEDDED DASHBOARD ASSETS
//
// The dashboard ships its CSS and client JS inside template literals, which no
// JS bundler can minify: to esbuild/rollup they are opaque string data. This
// step minifies those strings in the compiled output, cutting ~19% off the
// bundle size every consumer pays for.
//
// Runs after `tsc`, against dist/ only — src/ stays readable.
// =============================================================================

import { readFile, writeFile } from 'node:fs/promises';
import { transform } from 'esbuild';

/** Compiled modules holding embedded assets, and the CSS consts in each. */
const TARGETS = [
    { file: 'dashboard-assets.js', css: ['BASE_CSS'], script: true },
    { file: 'dashboard.js', css: ['NODE_CSS'], script: false },
    { file: 'dashboard-edge.js', css: ['EDGE_CSS'], script: false }
];

const distUrl = (file) => new URL(`../dist/${file}`, import.meta.url);

/**
 * Find the template literal that starts at `openIdx` (the opening backtick) and
 * return [inner, endIdx]. Handles escaped backticks; these literals contain no
 * nested template literals.
 */
function readTemplate(src, openIdx) {
    let i = openIdx + 1;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '`') return [src.slice(openIdx + 1, i), i];
        i++;
    }
    throw new Error(`unterminated template literal at ${openIdx}`);
}

/** Replace a template literal's contents, preserving the backticks. */
function spliceTemplate(src, openIdx, endIdx, replacement) {
    return src.slice(0, openIdx + 1) + replacement + src.slice(endIdx);
}

/**
 * Minify JS that contains `${...}` interpolations by swapping each for an
 * identifier placeholder, minifying, then restoring. The placeholders are valid
 * expressions, so the result stays parseable.
 */
async function minifyInterpolatedJs(code) {
    const subs = [];
    const guarded = code.replace(/\$\{[^{}]*\}/g, (match) => {
        subs.push(match);
        return `__ITP${subs.length - 1}__`;
    });
    const { code: out } = await transform(guarded, { loader: 'js', minify: true });
    return out.replace(/__ITP(\d+)__/g, (_, i) => subs[Number(i)]);
}

/** IDs the client script drives; a dropped card would silently stop updating. */
const REQUIRED_IDS = {
    node: ['cpuVal', 'memVal', 'heapVal', 'rtVal', 'rpsVal', 'lagVal', 'uptime',
        'totalReq', 'errorRate', 'topRoutes', 'errorsPanel', 'cpuChart', 'healthList',
        'connBadge', 'themeToggle'],
    edge: ['rtVal', 'rpsVal', 'errRateVal', 'uptime', 'totalReq', 'errorRate',
        'topRoutes', 'errorsPanel', 'rtChart', 'healthList', 'connBadge', 'themeToggle']
};

/**
 * Render the minified output and check it survived: markup intact, client script
 * still parses, and interpolated values still land. Guards against a bad minify
 * shipping silently, since the unit tests run against src/ rather than dist/.
 */
async function validate() {
    const stamp = Date.now();
    const nodeMod = await import(`${distUrl('dashboard.js').href}?t=${stamp}`);
    const edgeMod = await import(`${distUrl('dashboard-edge.js').href}?t=${stamp}`);
    const props = {
        hostname: 'h', uptime: '1s', title: 'T',
        pollingInterval: 4321, inlineCharts: false
    };
    const variants = [
        ['node', nodeMod.generateDashboard(props), REQUIRED_IDS.node],
        ['edge', edgeMod.generateEdgeDashboard(props), REQUIRED_IDS.edge]
    ];

    for (const [name, html, ids] of variants) {
        for (const id of ids) {
            if (!html.includes(`id="${id}"`)) {
                throw new Error(`${name} dashboard lost element #${id}`);
            }
        }
        if (!html.includes('4321')) {
            throw new Error(`${name} dashboard lost its pollingInterval interpolation`);
        }
        // The client script is the last <script ...> block (it may carry a nonce).
        const open = html.lastIndexOf('<script');
        const script = html.slice(html.indexOf('>', open) + 1, html.lastIndexOf('</script>'));
        if (script.trim().length === 0) throw new Error(`${name} dashboard has an empty client script`);
        // Throws on a syntax error introduced by the placeholder round-trip.
        await transform(script, { loader: 'js' });
        if (!/<style>[\s\S]*\{[\s\S]*\}[\s\S]*<\/style>/.test(html)) {
            throw new Error(`${name} dashboard has no CSS rules left`);
        }
    }
    console.log('minify-assets: validated node + edge dashboards');
}

async function main() {
    let totalBefore = 0;
    let totalAfter = 0;

    for (const target of TARGETS) {
        const url = distUrl(target.file);
        let src = await readFile(url, 'utf8');
        const before = src.length;

        for (const name of target.css) {
            const decl = `const ${name} = \``;
            const at = src.indexOf(decl);
            if (at === -1) throw new Error(`${name} not found in dist/${target.file}`);
            const open = at + decl.length - 1;
            const [inner, end] = readTemplate(src, open);
            const { code } = await transform(inner, { loader: 'css', minify: true });
            src = spliceTemplate(src, open, end, code);
        }

        if (target.script) {
            // The shared client script: the single `return \`` inside clientScript().
            const fnAt = src.indexOf('function clientScript(');
            if (fnAt === -1) throw new Error(`clientScript() not found in dist/${target.file}`);
            const retAt = src.indexOf('return `', fnAt);
            if (retAt === -1) throw new Error('clientScript() return template not found');
            const open = retAt + 'return `'.length - 1;
            const [inner, end] = readTemplate(src, open);
            src = spliceTemplate(src, open, end, await minifyInterpolatedJs(inner));
        }

        await writeFile(url, src);
        totalBefore += before;
        totalAfter += src.length;
        console.log(`minify-assets: ${target.file} ${before} -> ${src.length} bytes`);
    }

    const saved = totalBefore - totalAfter;
    console.log(
        `minify-assets: total ${totalBefore} -> ${totalAfter} bytes ` +
        `(-${saved}, -${((saved / totalBefore) * 100).toFixed(1)}%)`
    );

    await validate();
}

main().catch((err) => {
    console.error('minify-assets failed:', err.message);
    process.exit(1);
});
