// The build step that minifies CSS/JS embedded in template literals.
import { describe, it, expect } from 'vitest';
import { readTemplate, spliceTemplate, guardInterpolations, minifyInterpolatedJs } from '../scripts/minify-lib.mjs';

describe('template literal helpers', () => {
    it('reads a template up to its closing backtick, honouring escapes', () => {
        const src = 'const a = `x \\` y ${1}`; rest';
        const open = src.indexOf('`');
        const [inner, end] = readTemplate(src, open);
        expect(inner).toBe('x \\` y ${1}');
        expect(spliceTemplate(src, open, end, 'Z')).toBe('const a = `Z`; rest');
    });

    it('throws on an unterminated template', () => {
        expect(() => readTemplate('`abc', 0)).toThrow(/unterminated/);
    });
});

describe('interpolation guarding', () => {
    it('captures interpolations whole, including nested braces and strings with braces', () => {
        const { guarded, subs } = guardInterpolations("var a = ${fn({ b: 1 })}; var c = ${x ? '}' : '{'};");
        expect(subs).toEqual(['${fn({ b: 1 })}', "${x ? '}' : '{'}"]);
        expect(guarded).toBe('var a = __ITP0__; var c = __ITP1__;');
    });

    it('leaves escaped dollar-braces alone', () => {
        expect(guardInterpolations('var s = "\\${not}";').subs).toEqual([]);
    });
});

describe('minifyInterpolatedJs', () => {
    it('minifies around interpolations and restores them', async () => {
        const out = await minifyInterpolatedJs('var   interval   =   ${pollingInterval};\nvar inline = ${a ? "true" : "false"};\nconsole.log(interval, inline);');
        expect(out).toContain('${pollingInterval}');
        expect(out).toContain('${a ? "true" : "false"}');
        expect(out).not.toMatch(/ {2,}/);
    });

    it('fails loudly if minification drops an interpolation', async () => {
        await expect(minifyInterpolatedJs('if (false) { use(${x}); }')).rejects.toThrow(/dropped 1 interpolation/);
    });
});
