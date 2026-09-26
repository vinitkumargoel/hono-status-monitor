// =============================================================================
// HONO STATUS MONITOR - PLATFORM DETECTION
// Detect runtime environment (Node.js, Bun, Cloudflare Workers, Edge, etc.)
// =============================================================================

/**
 * Supported platform types
 */
export type Platform = 'node' | 'bun' | 'deno' | 'cloudflare' | 'edge' | 'unknown';

/**
 * Detect the current runtime platform.
 *
 * Runtimes that emulate Node (Bun, Deno, Workers with `nodejs_compat`) all
 * expose `process.versions.node`, so the specific runtimes are checked first
 * and Node last.
 *
 * @returns The detected platform type
 */
export function detectPlatform(): Platform {
    const g = globalThis as {
        process?: { versions?: Record<string, string | undefined> };
        navigator?: { userAgent?: unknown };
        caches?: { default?: unknown };
        Deno?: unknown;
        EdgeRuntime?: unknown;
    };
    const versions = g.process?.versions;

    if (versions?.bun) return 'bun';
    if (typeof g.Deno !== 'undefined') return 'deno';

    // Cloudflare Workers: navigator.userAgent, then the caches.default API.
    const userAgent = g.navigator?.userAgent;
    if (typeof userAgent === 'string' && userAgent.includes('Cloudflare-Workers')) return 'cloudflare';
    if (typeof g.caches !== 'undefined' && typeof g.caches.default !== 'undefined') return 'cloudflare';

    // Vercel Edge and other runtimes that set the EdgeRuntime global.
    if (typeof g.EdgeRuntime !== 'undefined') return 'edge';

    if (versions?.node) return 'node';
    return 'unknown';
}

/**
 * Check if running in a Node.js environment
 */
export function isNodeEnvironment(): boolean {
    return detectPlatform() === 'node';
}

/**
 * Check if running in a Bun environment
 */
export function isBunEnvironment(): boolean {
    return detectPlatform() === 'bun';
}

/**
 * Check if running in a Cloudflare Workers environment
 */
export function isCloudflareEnvironment(): boolean {
    return detectPlatform() === 'cloudflare';
}

/**
 * Check if running in Deno
 */
export function isDenoEnvironment(): boolean {
    return detectPlatform() === 'deno';
}

/**
 * Check if running in an edge environment (Cloudflare, Vercel Edge, etc.).
 * Deno is not counted as edge: it runs the full Node-compatible monitor.
 */
export function isEdgeEnvironment(): boolean {
    const platform = detectPlatform();
    return platform === 'cloudflare' || platform === 'edge';
}

/**
 * Get platform-specific information
 */
export function getPlatformInfo(): {
    platform: Platform;
    hasOsModule: boolean;
    hasProcessModule: boolean;
    hasClusterSupport: boolean;
} {
    const platform = detectPlatform();
    const isNodeCompatible = platform === 'node' || platform === 'bun' || platform === 'deno';

    return {
        platform,
        hasOsModule: isNodeCompatible,
        hasProcessModule: isNodeCompatible,
        hasClusterSupport: platform === 'node'
    };
}
