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
