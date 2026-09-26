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

import type { AlertEvent, HealthCheckDefinition, HealthCheckFn, StatusLogger, StatusMonitorConfig, StatusStore } from './types.js';
import { DEFAULT_HEALTH_CHECK } from './stats-core.js';

/**
 * Defaults shared by the Node and edge monitors. Each monitor overrides the
 * handful that differ (intervals, cluster mode). Optional callbacks default to
 * `undefined`, cast to satisfy `Required<>`.
 */
export function baseDefaults(): Required<StatusMonitorConfig> {
    return {
        path: '/status',
        title: 'Server Status',
        socketPath: '/status/socket.io', // Deprecated; unused.
        pollingInterval: 1000,
        updateInterval: 1000,
        retentionSeconds: 60,
        maxRecentErrors: 10,
        maxRoutes: 10,
        maxTrackedRoutes: 1000,
        alerts: { cpu: 80, memory: 90, responseTime: 500, errorRate: 5, eventLoopLag: 100 },
        healthCheck: DEFAULT_HEALTH_CHECK,
        healthCheckTimeout: 0, // No timeout unless configured; 5000 in 2.0.
        healthChecks: undefined as unknown as Record<string, HealthCheckFn | HealthCheckDefinition>,
        normalizePath: (path: string) => path, // Replaced by defaultNormalizePath at merge.
        groupBy: 'path',
        ignorePaths: [],
        sampleRate: 1,
        logger: console as StatusLogger,
        maxStreamClients: 100,
        clusterMode: undefined as unknown as boolean, // Auto-detected on Node.
        authorize: undefined as unknown as (c: any) => boolean | Promise<boolean>,
        onAlert: undefined as unknown as (event: AlertEvent) => void,
        prometheus: true,
        prometheusPrefix: 'hono',
        prometheusHistogram: false,
        chartjsUrl: undefined as unknown as string,
        chartAdapterUrl: undefined as unknown as string,
        inlineCharts: false,
        securityHeaders: false, // Opt-in in 1.x; default in 2.0.
        store: undefined as unknown as StatusStore,
        instanceId: undefined as unknown as string,
        storeWriteInterval: 60000,
        maxPeers: 50
    };
}

const SILENT: StatusLogger = { log() {}, warn() {}, error() {} };

/** The logger a config resolves to (`false` → silent). */
export function resolveLogger(logger: StatusLogger | false | undefined): StatusLogger {
    return logger === false ? SILENT : logger ?? console;
}

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
    | 'healthCheckTimeout'
    | 'maxStreamClients'
    | 'maxPeers'
    | 'sampleRate';

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
    healthCheckTimeout: 'nonNegative',
    maxStreamClients: 'positive',
    maxPeers: 'nonNegative',
    sampleRate: 'nonNegative'
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
            (RULES[key] === 'positive' ? value > 0 : value >= 0) &&
            (key !== 'sampleRate' || value <= 1);

        if (valid) {
            if (value !== raw) set(key, value as number);
            continue;
        }
        const requirement = key === 'sampleRate' ? 'a number from 0 to 1'
            : RULES[key] === 'positive' ? 'a number > 0' : 'a number >= 0';
        warn(`[hono-status-monitor] ${key} must be ${requirement}; got ${String(raw)}, using default ${defaults[key]}.`);
        set(key, defaults[key] as number);
    }
    return out;
}
