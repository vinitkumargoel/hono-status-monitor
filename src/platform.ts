// =============================================================================
// HONO STATUS MONITOR - PLATFORM DETECTION
// Detect runtime environment (Node.js, Cloudflare Workers, Edge, etc.)
// =============================================================================

/**
 * Supported platform types
 */
export type Platform = 'node' | 'cloudflare' | 'edge' | 'unknown';

/**
 * Detect the current runtime platform
 * 
 * @returns The detected platform type
 */
export function detectPlatform(): Platform {
    // Check for Node.js
    if (typeof process !== 'undefined' && process.versions?.node) {
        return 'node';
    }

    // Check for Cloudflare Workers
    // Cloudflare Workers have specific globals and navigator.userAgent
    if (typeof globalThis !== 'undefined') {
        // Cloudflare Workers environment check
        // @ts-ignore - navigator may not exist in all environments
        const userAgent = typeof navigator !== 'undefined' ? navigator?.userAgent : '';
        if (typeof userAgent === 'string' && userAgent.includes('Cloudflare-Workers')) {
            return 'cloudflare';
        }

        // Check for caches API which exists in Cloudflare Workers
        // @ts-ignore - caches may not exist
        if (typeof caches !== 'undefined' && typeof caches.default !== 'undefined') {
            return 'cloudflare';
        }
    }

    // Check for Deno
    // @ts-ignore - Deno global
    if (typeof Deno !== 'undefined') {
        return 'edge';
    }

    // Check for Bun
    // @ts-ignore - Bun global
    if (typeof Bun !== 'undefined') {
        return 'node'; // Bun is Node.js compatible
    }

    // Generic edge runtime (Vercel Edge, etc.)
    // @ts-ignore - EdgeRuntime global may not exist in all environments
    if (typeof EdgeRuntime !== 'undefined') {
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
    const isNode = platform === 'node';

    return {
        platform,
        hasOsModule: isNode,
        hasProcessModule: isNode,
        hasWebSocketSupport: isNode, // Full socket.io support
        hasClusterSupport: isNode
    };
}
