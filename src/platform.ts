// =============================================================================
// HONO STATUS MONITOR - PLATFORM DETECTION
// Detect runtime environment (Node.js, Bun, Cloudflare Workers, Edge, etc.)
// =============================================================================

/**
 * Supported platform types
 */
export type Platform = 'node' | 'bun' | 'cloudflare' | 'edge' | 'unknown';

/**
 * Detect the current runtime platform
 * 
 * @returns The detected platform type
 */
export function detectPlatform(): Platform {
    // Check for Bun before Node.js because Bun exposes process.versions.node.
    if (typeof process !== 'undefined' && 'bun' in process.versions) {
        return 'bun';
    }

    // Check for Node.js
    if (typeof process !== 'undefined' && process.versions?.node) {
        return 'node';
    }

    const g = globalThis as {
        navigator?: { userAgent?: unknown };
        caches?: { default?: unknown };
        Deno?: unknown;
        EdgeRuntime?: unknown;
    };

    // Check for Cloudflare Workers (navigator.userAgent, then the caches.default API)
    const userAgent = g.navigator?.userAgent;
    if (typeof userAgent === 'string' && userAgent.includes('Cloudflare-Workers')) {
        return 'cloudflare';
    }
    if (typeof g.caches !== 'undefined' && typeof g.caches.default !== 'undefined') {
        return 'cloudflare';
    }

    // Check for Deno
    if (typeof g.Deno !== 'undefined') {
        return 'edge';
    }

    // Generic edge runtime (Vercel Edge, etc.)
    if (typeof g.EdgeRuntime !== 'undefined') {
        return 'edge';
    }

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
 * Check if running in any edge environment (Cloudflare, Vercel Edge, etc.)
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
    hasWebSocketSupport: boolean;
    hasClusterSupport: boolean;
} {
    const platform = detectPlatform();
    const isNodeCompatible = platform === 'node' || platform === 'bun';

    return {
        platform,
        hasOsModule: isNodeCompatible,
        hasProcessModule: isNodeCompatible,
        hasWebSocketSupport: isNodeCompatible,
        hasClusterSupport: platform === 'node'
    };
}
