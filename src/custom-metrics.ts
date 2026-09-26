// =============================================================================
// HONO STATUS MONITOR - CUSTOM METRICS
// Application counters and gauges exported next to the built-in metrics on
// /prometheus and /api/metrics. Per instance: not merged across cluster
// workers or edge isolates.
// =============================================================================

import { sanitizeLabel } from './format.js';

export type MetricLabels = Record<string, string | number>;

export interface CounterMetric {
    /** Add `value` (default 1, must be >= 0) to the series with these labels. */
    inc(labels?: MetricLabels, value?: number): void;
}

export interface GaugeMetric {
    /** Set the series with these labels to `value`. */
    set(value: number, labels?: MetricLabels): void;
    /** Add `value` (default 1, may be negative) to the series with these labels. */
    inc(labels?: MetricLabels, value?: number): void;
}

/** One exported series, as it appears in `/api/metrics` under `custom`. */
export interface CustomMetricSeries {
    name: string;
    type: 'counter' | 'gauge';
    help: string;
    labels: Record<string, string>;
    value: number;
}

interface Family {
    type: 'counter' | 'gauge';
    help: string;
    series: Map<string, { labels: Record<string, string>; value: number }>;
    handle: CounterMetric | GaugeMetric;
    /** Set once the series cap has been hit and warned about. */
    capped: boolean;
}

const NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Upper bound on label combinations per metric, so a label fed from request data can't grow memory without bound. */
export const MAX_SERIES_PER_METRIC = 200;

export function createMetricRegistry(warn: (message: string) => void = () => {}) {
    const families = new Map<string, Family>();

    function seriesFor(name: string, family: Family, labels: MetricLabels | undefined) {
        const normalized: Record<string, string> = {};
        for (const key of Object.keys(labels ?? {}).sort()) {
            if (!NAME.test(key)) throw new TypeError(`[hono-status-monitor] Invalid label name "${key}" on metric "${name}"`);
            normalized[key] = String((labels as MetricLabels)[key]);
        }
        const id = JSON.stringify(normalized);
        let series = family.series.get(id);
        if (!series) {
            if (family.series.size >= MAX_SERIES_PER_METRIC) {
                if (!family.capped) {
                    family.capped = true;
                    warn(`[hono-status-monitor] Metric "${name}" reached ${MAX_SERIES_PER_METRIC} label combinations; new ones are dropped.`);
                }
                return null;
            }
            series = { labels: normalized, value: 0 };
            family.series.set(id, series);
        }
        return series;
    }

    function register<T extends CounterMetric | GaugeMetric>(
        type: 'counter' | 'gauge',
        name: string,
        help: string,
        make: (family: Family) => T
    ): T {
        if (!NAME.test(name)) throw new TypeError(`[hono-status-monitor] Invalid metric name "${name}"`);
        const existing = families.get(name);
        if (existing) {
            if (existing.type !== type) {
                throw new TypeError(`[hono-status-monitor] Metric "${name}" is already registered as a ${existing.type}`);
            }
            return existing.handle as T;
        }
        const family: Family = { type, help, series: new Map(), handle: undefined as unknown as T, capped: false };
        family.handle = make(family);
        families.set(name, family);
        return family.handle as T;
    }

    const finite = (name: string, value: number) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new TypeError(`[hono-status-monitor] Metric "${name}" got a non-finite value: ${String(value)}`);
        }
    };

    return {
        counter(name: string, help = name): CounterMetric {
            return register('counter', name, help, (family) => ({
                inc(labels, value = 1) {
                    finite(name, value);
                    if (value < 0) throw new TypeError(`[hono-status-monitor] Counter "${name}" can't decrease`);
                    const series = seriesFor(name, family, labels);
                    if (series) series.value += value;
                }
            }));
        },

        gauge(name: string, help = name): GaugeMetric {
            return register('gauge', name, help, (family) => ({
                set(value, labels) {
                    finite(name, value);
                    const series = seriesFor(name, family, labels);
                    if (series) series.value = value;
                },
                inc(labels, value = 1) {
                    finite(name, value);
                    const series = seriesFor(name, family, labels);
                    if (series) series.value += value;
                }
            }));
        },

        /** Every series, for the JSON API. */
        list(): CustomMetricSeries[] {
            const out: CustomMetricSeries[] = [];
            for (const [name, family] of families) {
                for (const series of family.series.values()) {
                    out.push({ name, type: family.type, help: family.help, labels: { ...series.labels }, value: series.value });
                }
            }
            return out;
        },

        /** Prometheus text for every registered metric, names prefixed like the built-ins. */
        toPrometheus(prefix: string): string {
            const p = prefix.replace(/[^a-zA-Z0-9_]/g, '_');
            let out = '';
            for (const [name, family] of families) {
                const full = `${p}_${name}`;
                out += `# HELP ${full} ${family.help.replace(/[\r\n]+/g, ' ')}\n# TYPE ${full} ${family.type}\n`;
                for (const series of family.series.values()) {
                    const labels = Object.entries(series.labels);
                    const labelStr = labels.length
                        ? `{${labels.map(([k, v]) => `${k}="${sanitizeLabel(v)}"`).join(',')}}`
                        : '';
                    out += `${full}${labelStr} ${series.value}\n`;
                }
            }
            return out;
        },

        get size() {
            return families.size;
        }
    };
}

export type MetricRegistry = ReturnType<typeof createMetricRegistry>;
