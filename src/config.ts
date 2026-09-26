// =============================================================================
// HONO STATUS MONITOR - CONFIG MERGING AND SANITIZING
//
// - An explicit `undefined` (`healthCheck: cond ? fn : undefined`) means "use
//   the default", not "overwrite the default with undefined".
// - Options that can't work (zero or negative intervals, NaN, wrong types)
//   throw at construction instead of degrading at runtime. Numeric strings
//   (e.g. from env vars) are accepted and converted.
// =============================================================================

import type { Context } from 'hono';
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
        pollingInterval: 1000,
        updateInterval: 1000,
        retentionSeconds: 60,
        maxRecentErrors: 10,
        maxRoutes: 10,
        maxTrackedRoutes: 1000,
        alerts: { cpu: 80, memory: 90, responseTime: 500, errorRate: 5, eventLoopLag: 100 },
        healthCheck: DEFAULT_HEALTH_CHECK,
        healthCheckTimeout: 5000,
        healthChecks: undefined as unknown as Record<string, HealthCheckFn | HealthCheckDefinition>,
        normalizePath: (path: string) => path, // Replaced by defaultNormalizePath at merge.
        groupBy: 'path',
        ignorePaths: [],
        sampleRate: 1,
        logger: console as StatusLogger,
        maxStreamClients: 100,
        clusterMode: undefined as unknown as boolean, // Auto-detected on Node.
        authorize: undefined as unknown as (c: Context) => boolean | Promise<boolean>,
        publicAccess: false,
        onAlert: undefined as unknown as (event: AlertEvent) => void,
        prometheus: true,
        prometheusPrefix: 'hono',
        prometheusHistogram: false,
        chartjsUrl: undefined as unknown as string,
        chartAdapterUrl: undefined as unknown as string,
        inlineCharts: false,
        securityHeaders: true,
        store: undefined as unknown as StatusStore,
        instanceId: undefined as unknown as string,
        storeWriteInterval: 60000,
        maxPeers: 50
    };
}

/** A logger with every method present, as the monitors use it internally. */
export type ResolvedLogger = Required<Pick<StatusLogger, 'log' | 'warn' | 'error'>>;

const noop = () => {};
const SILENT: ResolvedLogger = { log: noop, warn: noop, error: noop };

/** The logger a config resolves to (`false` → silent; `log` falls back to `info`). */
export function resolveLogger(logger: StatusLogger | false | undefined): ResolvedLogger {
    if (logger === false) return SILENT;
    const l = logger ?? console;
    const info = l.log ?? l.info;
    return {
        log: info ? info.bind(l) : noop,
        warn: l.warn.bind(l),
        error: l.error.bind(l)
    };
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

/** Thrown by the monitor factories when a config option can't work. */
export class StatusMonitorConfigError extends TypeError {
    constructor(readonly problems: string[]) {
        super(`[hono-status-monitor] Invalid config:\n  - ${problems.join('\n  - ')}`);
        this.name = 'StatusMonitorConfigError';
    }
}

const FUNCTION_KEYS = ['healthCheck', 'normalizePath', 'authorize', 'onAlert'] as const;
const BOOLEAN_KEYS = ['clusterMode', 'publicAccess', 'prometheus', 'prometheusHistogram', 'inlineCharts', 'securityHeaders'] as const;
const STRING_KEYS = ['path', 'title', 'prometheusPrefix', 'chartjsUrl', 'chartAdapterUrl', 'instanceId'] as const;

/**
 * A short rendering of a rejected value for the error message. Strings are
 * truncated, so a secret pasted into the wrong option isn't logged whole.
 */
function describe(value: unknown): string {
    if (typeof value === 'string') {
        return value.length > 24 ? `${JSON.stringify(value.slice(0, 12))}… (${value.length} chars)` : JSON.stringify(value);
    }
    if (typeof value === 'function') return 'a function';
    if (Array.isArray(value)) return 'an array';
    return String(value);
}

/**
 * Validate a merged config and return a copy with numeric strings converted
 * (handy for env vars). Throws {@link StatusMonitorConfigError} listing every
 * problem at once, so a misconfiguration fails at startup instead of degrading
 * silently at runtime.
 */
export function validateConfig<C extends Required<StatusMonitorConfig>>(config: C): C {
    const out = { ...config };
    const problems: string[] = [];

    for (const key of Object.keys(RULES) as NumericKey[]) {
        const raw = out[key] as unknown;
        const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
        const valid = typeof value === 'number' && Number.isFinite(value) &&
            (RULES[key] === 'positive' ? value > 0 : value >= 0) &&
            (key !== 'sampleRate' || value <= 1);
        if (valid) {
            (out as Record<NumericKey, number>)[key] = value as number;
            continue;
        }
        const requirement = key === 'sampleRate' ? 'a number from 0 to 1'
            : RULES[key] === 'positive' ? 'a number > 0' : 'a number >= 0';
        problems.push(`${key} must be ${requirement}; got ${describe(raw)}`);
    }

    for (const [metric, value] of Object.entries(out.alerts ?? {})) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            problems.push(`alerts.${metric} must be a finite number; got ${describe(value)}`);
        }
    }
    for (const key of FUNCTION_KEYS) {
        const v = out[key] as unknown;
        if (v !== undefined && typeof v !== 'function') problems.push(`${key} must be a function; got ${describe(v)}`);
    }
    for (const key of BOOLEAN_KEYS) {
        const v = out[key] as unknown;
        if (v !== undefined && typeof v !== 'boolean') problems.push(`${key} must be true or false; got ${describe(v)}`);
    }
    for (const key of STRING_KEYS) {
        const v = out[key] as unknown;
        if (v !== undefined && typeof v !== 'string') problems.push(`${key} must be a string; got ${describe(v)}`);
    }
    if (typeof out.path === 'string' && !out.path.startsWith('/')) {
        problems.push(`path must start with "/"; got ${describe(out.path)}`);
    }
    if (out.groupBy !== 'path' && out.groupBy !== 'route') {
        problems.push(`groupBy must be 'path' or 'route'; got ${describe(out.groupBy)}`);
    }
    const ignore = out.ignorePaths as unknown;
    if (typeof ignore !== 'function' && !(Array.isArray(ignore) &&
        ignore.every((p) => typeof p === 'string' || p instanceof RegExp))) {
        problems.push('ignorePaths must be an array of strings/RegExps or a function');
    }
    if (out.healthChecks !== undefined) {
        if (!out.healthChecks || typeof out.healthChecks !== 'object') {
            problems.push('healthChecks must be an object of named checks');
        } else {
            for (const [name, def] of Object.entries(out.healthChecks)) {
                const fn = typeof def === 'function' ? def : (def as { check?: unknown } | null)?.check;
                if (typeof fn !== 'function') problems.push(`healthChecks.${name} must be a function or { check }`);
            }
        }
    }
    const logger = out.logger as unknown as Record<string, unknown> | false;
    if (logger !== false && (typeof logger?.warn !== 'function' || typeof logger?.error !== 'function')) {
        problems.push('logger must be false or implement warn and error');
    }
    const store = out.store as unknown as Record<string, unknown> | undefined;
    if (store !== undefined && (typeof store?.get !== 'function' || typeof store?.put !== 'function' || typeof store?.list !== 'function')) {
        problems.push('store must implement get, put and list');
    }

    if (problems.length) throw new StatusMonitorConfigError(problems);
    return out;
}
