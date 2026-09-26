// =============================================================================
// HONO STATUS MONITOR - CONFIG MERGING AND SANITIZING
//
// Two jobs, both aimed at configs that used to degrade silently:
//  - an explicit `undefined` (`healthCheck: cond ? fn : undefined`) must mean
//    "use the default", not overwrite the default with undefined;
//  - numeric options that are unusable (zero or negative intervals, NaN) are
//    replaced with the default instead of reaching setInterval or array caps.
// Values that worked before keep working, including numeric strings.
// =============================================================================

import type { StatusMonitorConfig } from './types.js';

/** Drop keys whose value is `undefined`, so they can't shadow a default. */
function definedOnly<T extends object>(obj: T | undefined): Partial<T> {
    const out: Partial<T> = {};
    if (!obj) return out;
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    return out;
}

/**
 * Merge user config over defaults. `undefined` values (top level and inside
 * `alerts`) fall through to the default; `normalizePath` falls back to the
 * given default normalizer.
 */
export function mergeConfig(
    defaults: Required<StatusMonitorConfig>,
    user: StatusMonitorConfig,
    overrides: Partial<Required<StatusMonitorConfig>> = {}
): Required<StatusMonitorConfig> {
    const u = definedOnly(user);
    return {
        ...defaults,
        ...u,
        alerts: { ...defaults.alerts, ...definedOnly(user.alerts) },
        ...overrides
    };
}

type NumericKey =
    | 'pollingInterval'
    | 'updateInterval'
    | 'retentionSeconds'
    | 'maxRecentErrors'
    | 'maxRoutes'
    | 'maxTrackedRoutes'
    | 'storeWriteInterval'
    | 'healthCheckTimeout';

/**
 * `positive`: must be > 0 (intervals, windows, caps that break at zero).
 * `nonNegative`: 0 is meaningful (show no routes, keep no errors, no timeout).
 */
const RULES: Record<NumericKey, 'positive' | 'nonNegative'> = {
    pollingInterval: 'positive',
    updateInterval: 'positive',
    retentionSeconds: 'positive',
    maxTrackedRoutes: 'positive',
    storeWriteInterval: 'positive',
    maxRecentErrors: 'nonNegative',
    maxRoutes: 'nonNegative',
    healthCheckTimeout: 'nonNegative'
};

/**
 * Return a copy of `config` with every numeric option usable. Numeric strings
 * are converted; anything non-numeric, non-finite or out of range is replaced by
 * the default with a one-line warning naming the option.
 */
export function sanitizeConfig<C extends Required<StatusMonitorConfig>>(
    config: C,
    defaults: C,
    warn: (message: string) => void = (m) => console.warn(m)
): C {
    const out = { ...config };
    const set = (key: NumericKey, value: number) => {
        (out as Record<NumericKey, number>)[key] = value;
    };

    for (const key of Object.keys(RULES) as NumericKey[]) {
        const raw = out[key] as unknown;
        const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
        const valid = typeof value === 'number' && Number.isFinite(value) &&
            (RULES[key] === 'positive' ? value > 0 : value >= 0);

        if (valid) {
            if (value !== raw) set(key, value as number);
            continue;
        }
        const requirement = RULES[key] === 'positive' ? 'a number > 0' : 'a number >= 0';
        warn(`[hono-status-monitor] ${key} must be ${requirement}; got ${String(raw)}, using default ${defaults[key]}.`);
        set(key, defaults[key] as number);
    }
    return out;
}
