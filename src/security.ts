// =============================================================================
// HONO STATUS MONITOR - DASHBOARD SECURITY HEADERS
// Baseline headers that are always safe, plus an opt-in nonce-based CSP and
// anti-framing policy.
// =============================================================================

/**
 * A per-response CSP nonce from Web Crypto (Node 19+, Bun, Deno, edge). Node
 * 18 has no global Web Crypto, so the Node entry passes its own generator
 * backed by `node:crypto`; this fallback is only reached if neither exists.
 */
export function generateNonce(): string {
    const bytes = new Uint8Array(16);
    const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
    if (c && typeof c.getRandomValues === 'function') {
        c.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

/**
 * The CSP source for a script URL, resolved against the page URL: `'self'` for
 * same-origin scripts, the origin for http(s) scripts elsewhere, null for
 * anything that can't be expressed safely (other schemes, backslashes that
 * browsers and URL parsers may resolve differently).
 */
export function scriptSourceFor(url: string, pageUrl: string): string | null {
    if (url.includes('\\')) return null;
    try {
        const page = new URL(pageUrl);
        const { protocol, origin } = new URL(url, page);
        if (protocol !== 'https:' && protocol !== 'http:') return null;
        return origin === page.origin ? "'self'" : origin;
    } catch {
        return null;
    }
}

/** Always sent: harmless for every deployment. */
export const BASELINE_HEADERS: Readonly<Record<string, string>> = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
};

/**
 * Sent unless `securityHeaders: false`: a nonce-based CSP and same-origin framing.
 * Returns only the baseline headers if a script URL can't be expressed as a CSP
 * source — sending a policy that blocks the configured Chart.js would be worse
 * than sending none.
 */
export function dashboardSecurityHeaders(
    nonce: string,
    scriptUrls: string[],
    pageUrl: string
): Record<string, string> {
    const sources = new Set<string>([`'nonce-${nonce}'`]);
    for (const url of scriptUrls) {
        const src = scriptSourceFor(url, pageUrl);
        if (!src) return { ...BASELINE_HEADERS };
        sources.add(src);
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
        ...BASELINE_HEADERS,
        'Content-Security-Policy': csp,
        'X-Frame-Options': 'SAMEORIGIN'
    };
}
