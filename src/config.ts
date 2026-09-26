// =============================================================================
// HONO STATUS MONITOR - CONFIG SANITIZING
// Numeric options are clamped into a safe range rather than passed straight to
// setInterval/array caps, where a zero or negative value degrades silently
// (a hot loop, history discarded on write, a route cap that never evicts).
// =============================================================================

import type { StatusMonitorConfig } from './types.js';

type NumericKey =
    | 'pollingInterval'
    | 'updateInterval'
    | 'retentionSeconds'
    | 'maxRecentErrors'
    | 'maxRoutes'
    | 'maxTrackedRoutes'
    | 'storeWriteInterval'
    | 'healthCheckTimeout';

/** Inclusive lower bound for each numeric option. */
const MINIMUMS: Record<NumericKey, number> = {
    pollingInterval: 250,
    updateInterval: 100,
    retentionSeconds: 1,
    maxRecentErrors: 0,
    maxRoutes: 1,
    maxTrackedRoutes: 1,
    storeWriteInterval: 1000,
    healthCheckTimeout: 1
};

/**
 * Return a copy of `config` with every numeric option finite and at or above
 * its minimum. Out-of-range values fall back to the default (non-finite) or the
 * minimum (too small), with a one-line warning naming the option.
 */
export function sanitizeConfig<C extends Required<StatusMonitorConfig>>(
    config: C,
    defaults: C,
    warn: (message: string) => void = (m) => console.warn(m)
): C {
    const out = { ...config };
    for (const key of Object.keys(MINIMUMS) as NumericKey[]) {
        const value = out[key] as unknown;
        const min = MINIMUMS[key];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            warn(`[hono-status-monitor] ${key} must be a finite number; using default ${defaults[key]}.`);
            (out as Record<NumericKey, number>)[key] = defaults[key] as number;
        } else if (value < min) {
            warn(`[hono-status-monitor] ${key} must be >= ${min}; got ${value}, using ${min}.`);
            (out as Record<NumericKey, number>)[key] = min;
        }
    }
    return out;
}
