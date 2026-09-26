// =============================================================================
// HONO STATUS MONITOR - SHARED METRICS UTILITIES
// =============================================================================

import type { MetricDataPoint, PercentileData } from './types.js';

export function round(value: number, precision = 2): number {
    const multiplier = 10 ** precision;
    return Math.round(value * multiplier) / multiplier;
}

export function defaultNormalizePath(path: string): string {
    return path
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':uuid')
        .replace(/[0-9a-f]{24}/gi, ':id')
        // Only collapse whole numeric segments (e.g. /users/42), not segments that
        // merely start with a digit (e.g. /2fa/verify).
        .replace(/\/\d+(?=\/|$)/g, '/:id')
        .split('/')
        .slice(0, 4)
        .join('/');
}

export function calculatePercentiles(samples: number[]): PercentileData {
    if (samples.length === 0) {
        return { p50: 0, p95: 0, p99: 0, avg: 0 };
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const percentile = (value: number) => {
        const index = Math.max(0, Math.ceil(value * sorted.length) - 1);
        return round(sorted[Math.min(index, sorted.length - 1)] ?? 0);
    };

    return {
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
        avg: round(sorted.reduce((a, b) => a + b, 0) / sorted.length)
    };
}

export function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);

    return parts.join(' ');
}

/** The newest value in a chart series, or 0 when it's empty. */
export function latest(series: MetricDataPoint[]): number {
    return series.at(-1)?.value ?? 0;
}
