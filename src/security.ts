// =============================================================================
// HONO STATUS MONITOR - DASHBOARD SECURITY HEADERS
// Nonce-based CSP and anti-framing headers for the dashboard page.
// =============================================================================

/** A per-response CSP nonce. Uses Web Crypto where available (Node 19+, Bun, edge). */
export function generateNonce(): string {
    const bytes = new Uint8Array(16);
    const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
    if (c && typeof c.getRandomValues === 'function') {
        c.getRandomValues(bytes);
    } else {
        // Node 18 without the global: still unguessable enough for a nonce that
        // lives for one response, and only reached on an end-of-life runtime.
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

/**
 * The CSP source for a script URL: its origin for absolute URLs, `'self'` for
 * relative ones (a self-hosted Chart.js). Returns null for anything unparsable
 * so a bad URL can't inject extra directives.
 */
export function scriptSourceFor(url: string): string | null {
    if (/^\/(?!\/)/.test(url) || url.startsWith('./') || url.startsWith('../')) return "'self'";
    try {
        const { protocol, origin } = new URL(url);
        return protocol === 'https:' || protocol === 'http:' ? origin : null;
    } catch {
        return null;
    }
}

/** Headers for the dashboard HTML response. */
export function dashboardSecurityHeaders(nonce: string, scriptUrls: string[]): Record<string, string> {
    const sources = new Set<string>([`'nonce-${nonce}'`]);
    for (const url of scriptUrls) {
        const src = scriptSourceFor(url);
        if (src) sources.add(src);
    }
    const csp = [
        "default-src 'none'",
        `script-src ${[...sources].join(' ')}`,
        // Inline <style> block and a few style attributes.
        "style-src 'unsafe-inline'",
        "img-src 'self' data:",
        // The client polls <mount>/api/metrics on the same origin.
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'self'"
    ].join('; ');
    return {
        'Content-Security-Policy': csp,
        'X-Frame-Options': 'SAMEORIGIN',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
    };
}
