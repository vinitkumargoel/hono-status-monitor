// =============================================================================
// HONO STATUS MONITOR - OPENTELEMETRY BRIDGE
// Publishes MetricsSnapshot values as OTel observable instruments without a
// dependency on @opentelemetry/*. The structural types below are a subset of
// @opentelemetry/api's `Meter`, so a real Meter is assignable to `MeterLike`.
// No Node imports: safe on edge runtimes.
// =============================================================================

import type { MetricsSnapshot } from './types.js';

/** Attribute map passed with an observation (subset of OTel `Attributes`). */
export type OtelAttributes = Record<string, string | number | boolean>;

/** Structural match for OTel `MetricOptions`. */
export interface OtelInstrumentOptions {
    description?: string;
    unit?: string;
}

/** Structural match for OTel `ObservableResult`. */
export interface ObservableResultLike {
    observe(value: number, attributes?: OtelAttributes): void;
}

/** Structural match for OTel `Observable` (ObservableGauge / ObservableCounter). */
export interface ObservableLike {
    addCallback(callback: (result: ObservableResultLike) => void | Promise<void>): void;
    removeCallback(callback: (result: ObservableResultLike) => void | Promise<void>): void;
}

/** Structural match for OTel `BatchObservableResult`. */
export interface BatchObservableResultLike {
    observe(observable: ObservableLike, value: number, attributes?: OtelAttributes): void;
}

export type BatchObservableCallbackLike = (result: BatchObservableResultLike) => void | Promise<void>;

/** The subset of `@opentelemetry/api`'s `Meter` this bridge uses. */
export interface MeterLike {
    createObservableGauge(name: string, options?: OtelInstrumentOptions): ObservableLike;
    createObservableCounter(name: string, options?: OtelInstrumentOptions): ObservableLike;
    addBatchObservableCallback(callback: BatchObservableCallbackLike, observables: ObservableLike[]): void;
    removeBatchObservableCallback(callback: BatchObservableCallbackLike, observables: ObservableLike[]): void;
}

export interface OtelMetricsSource {
    getMetrics(): Promise<MetricsSnapshot>;
}

export interface OtelBridgeOptions {
    /** Instrument name prefix. Default `'hono'` (e.g. `hono.http.requests`). */
    prefix?: string;
    /** Publish cpu/memory/heap/event-loop gauges. Default `true`; set `false` on edge runtimes. */
    includeSystem?: boolean;
    /** Called when a snapshot fails; that collection cycle is skipped. */
    onError?: (error: unknown) => void;
}

export interface OtelRegistration {
    /** Detach the batch callback. Safe to call more than once. */
    unregister(): void;
}

const MB = 1024 * 1024;
const QUANTILES = [
    ['0.5', 'p50'],
    ['0.95', 'p95'],
    ['0.99', 'p99'],
] as const;

function sanitizePrefix(prefix: string | undefined): string {
    const cleaned = (prefix ?? 'hono').replace(/[^A-Za-z0-9_.\-/]/g, '_').replace(/^[^A-Za-z]+/, '');
    return cleaned || 'hono';
}

/**
 * Register observable instruments on an OpenTelemetry `Meter` that read from a
 * status monitor. All instruments share one batch callback, so each collection
 * cycle computes a single snapshot. A failing snapshot skips the cycle.
 */
export function registerOtelMetrics(
    meter: MeterLike,
    source: OtelMetricsSource,
    options: OtelBridgeOptions = {}
): OtelRegistration {
    const p = sanitizePrefix(options.prefix);
    const includeSystem = options.includeSystem !== false;
    const gauge = (name: string, description: string, unit: string) =>
        meter.createObservableGauge(`${p}.${name}`, { description, unit });
    const counter = (name: string, description: string, unit: string) =>
        meter.createObservableCounter(`${p}.${name}`, { description, unit });

    const http = {
        rate: gauge('http.request.rate', 'Requests per second', '{request}/s'),
        responseTime: gauge('http.response_time', 'Average response time', 'ms'),
        latency: gauge('http.response_time.quantile', 'Response time percentiles (quantile attribute)', 'ms'),
        errorRate: gauge('http.error_rate', 'Error rate percentage', '%'),
        active: gauge('http.active_requests', 'In-flight requests', '{request}'),
        requests: counter('http.requests', 'Total requests observed', '{request}'),
        responses: counter('http.responses', 'HTTP responses by status code (status attribute)', '{response}'),
    };
    const system = includeSystem
        ? {
              cpu: gauge('cpu.usage', 'CPU usage percentage', '%'),
              memory: gauge('memory.used', 'System memory used', 'By'),
              memoryPercent: gauge('memory.usage', 'System memory used percentage', '%'),
              heapUsed: gauge('heap.used', 'Heap used', 'By'),
              heapTotal: gauge('heap.total', 'Heap total', 'By'),
              eventLoopLag: gauge('event_loop.lag', 'Event loop lag', 'ms'),
              loadAvg: gauge('system.load_average.1m', 'System 1-minute load average', '1'),
          }
        : undefined;

    const observables: ObservableLike[] = [...Object.values(http), ...(system ? Object.values(system) : [])];

    // Observable counters must never decrease, but the snapshot's totals do:
    // resetStats() zeroes them, and an edge fleet total drops when a peer
    // expires. Treat a drop as a reset (the new value counted up from zero,
    // as Prometheus does) and carry the old total as an offset.
    const cumulative = new Map<string, { last: number; offset: number }>();
    const monotonic = (key: string, value: number): number => {
        const entry = cumulative.get(key) ?? { last: 0, offset: 0 };
        if (value < entry.last) entry.offset += entry.last;
        entry.last = value;
        cumulative.set(key, entry);
        return value + entry.offset;
    };

    const callback: BatchObservableCallbackLike = async (result) => {
        let s: MetricsSnapshot;
        try {
            s = await source.getMetrics();
        } catch (error) {
            options.onError?.(error);
            return;
        }
        const observe = (o: ObservableLike, value: unknown, attributes?: OtelAttributes) => {
            if (typeof value === 'number' && Number.isFinite(value)) result.observe(o, value, attributes);
        };

        observe(http.rate, s.rps);
        observe(http.responseTime, s.responseTime);
        observe(http.errorRate, s.errorRate);
        observe(http.active, s.activeConnections);
        if (Number.isFinite(s.totalRequests)) observe(http.requests, monotonic('requests', s.totalRequests));
        const percentiles = s.percentiles;
        if (percentiles) {
            for (const [quantile, key] of QUANTILES) observe(http.latency, percentiles[key], { quantile });
        }
        for (const [status, count] of Object.entries(s.statusCodes ?? {})) {
            if (Number.isFinite(count)) observe(http.responses, monotonic(`status:${status}`, count), { status });
        }

        if (system) {
            observe(system.cpu, s.cpu);
            observe(system.memory, s.memoryMB * MB);
            observe(system.memoryPercent, s.memoryPercent);
            observe(system.heapUsed, s.heapUsedMB * MB);
            observe(system.heapTotal, s.heapTotalMB * MB);
            observe(system.eventLoopLag, s.eventLoopLag);
            observe(system.loadAvg, s.loadAvg);
        }
    };

    meter.addBatchObservableCallback(callback, observables);

    let registered = true;
    return {
        unregister() {
            if (!registered) return;
            registered = false;
            meter.removeBatchObservableCallback(callback, observables);
        },
    };
}
