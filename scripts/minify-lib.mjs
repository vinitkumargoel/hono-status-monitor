// =============================================================================
// Helpers for minify-assets.mjs, split out so they can be unit-tested.
// =============================================================================

import { transform } from 'esbuild';

/**
 * Find the template literal that starts at `openIdx` (the opening backtick) and
 * return [inner, endIdx]. Handles escaped backticks; these literals contain no
 * nested template literals.
 */
export function readTemplate(src, openIdx) {
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
export function spliceTemplate(src, openIdx, endIdx, replacement) {
    return src.slice(0, openIdx + 1) + replacement + src.slice(endIdx);
}

/**
 * Replace each `${...}` interpolation in `code` with a placeholder identifier.
 * Scans with brace depth (and skips string literals inside the expression), so
 * an interpolation containing braces — `${fn({ a: 1 })}` — is captured whole
 * rather than silently left in place.
 */
export function guardInterpolations(code) {
    const subs = [];
    let out = '';
    let i = 0;
    while (i < code.length) {
        if (code[i] === '\\') { out += code.slice(i, i + 2); i += 2; continue; }
        if (code[i] === '$' && code[i + 1] === '{') {
            let depth = 1;
            let j = i + 2;
            let quote = null;
            while (j < code.length && depth > 0) {
                const ch = code[j];
                if (quote) {
                    if (ch === '\\') j++;
                    else if (ch === quote) quote = null;
                } else if (ch === "'" || ch === '"') {
                    quote = ch;
                } else if (ch === '{') {
                    depth++;
                } else if (ch === '}') {
                    depth--;
                }
                j++;
            }
            if (depth !== 0) throw new Error(`unterminated interpolation at ${i}`);
            subs.push(code.slice(i, j));
            out += `__ITP${subs.length - 1}__`;
            i = j;
            continue;
        }
        out += code[i++];
    }
    return { guarded: out, subs };
}

/**
 * Minify JS that contains `${...}` interpolations by swapping each for an
 * identifier placeholder, minifying, then restoring. The placeholders are valid
 * expressions, so the result stays parseable. Throws if a placeholder was lost
 * (e.g. dropped as dead code), since the value would silently go missing.
 */
export async function minifyInterpolatedJs(code) {
    const { guarded, subs } = guardInterpolations(code);
    const { code: out } = await transform(guarded, { loader: 'js', minify: true });
    const seen = new Set();
    const restored = out.replace(/__ITP(\d+)__/g, (_, n) => {
        seen.add(Number(n));
        return subs[Number(n)];
    });
    if (seen.size !== subs.length) {
        throw new Error(`minify dropped ${subs.length - seen.size} interpolation(s)`);
    }
    return restored;
}
