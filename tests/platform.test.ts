import { describe, it, expect, vi, afterEach } from 'vitest';

describe('platform detection', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('should detect Bun before Node.js when both version markers exist', async () => {
        vi.stubGlobal('process', {
            versions: {
                node: '20.0.0',
                bun: '1.2.0'
            }
        });

        const { detectPlatform, isBunEnvironment, getPlatformInfo } = await import('../src/platform');

        expect(detectPlatform()).toBe('bun');
        expect(isBunEnvironment()).toBe(true);
        expect(getPlatformInfo()).toEqual({
            platform: 'bun',
            hasOsModule: true,
            hasProcessModule: true,
            hasWebSocketSupport: true,
            hasClusterSupport: false
        });
    });
});

describe('platform detection across runtimes', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    // Every non-Node runtime is modelled as "no process.versions.node".
    const noNode = () => vi.stubGlobal('process', { versions: {} });

    it.each([
        ['Cloudflare user agent', { navigator: { userAgent: 'Cloudflare-Workers' } }, 'cloudflare'],
        ['Cloudflare caches.default', { caches: { default: {} } }, 'cloudflare'],
        ['Deno', { Deno: {} }, 'edge'],
        ['Vercel EdgeRuntime', { EdgeRuntime: 'edge-runtime' }, 'edge'],
        ['nothing recognisable', {}, 'unknown']
    ])('detects %s', async (_, globals, expected) => {
        noNode();
        for (const [k, v] of Object.entries(globals)) vi.stubGlobal(k, v);
        const p = await import('../src/platform');
        expect(p.detectPlatform()).toBe(expected);
        expect(p.isEdgeEnvironment()).toBe(expected === 'cloudflare' || expected === 'edge');
        expect(p.isCloudflareEnvironment()).toBe(expected === 'cloudflare');
        expect(p.isNodeEnvironment()).toBe(false);
        expect(p.getPlatformInfo().hasOsModule).toBe(false);
    });

    it('detects plain Node with cluster support', async () => {
        const p = await import('../src/platform');
        expect(p.detectPlatform()).toBe('node');
        expect(p.isNodeEnvironment()).toBe(true);
        expect(p.getPlatformInfo().hasClusterSupport).toBe(true);
    });
});
