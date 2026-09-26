// =============================================================================
// HONO STATUS MONITOR - CHART.JS CDN PINS
// The default Chart.js URLs and their Subresource Integrity hashes. Kept apart
// from the dashboard assets so the route layer can build a CSP without pulling
// the dashboard markup into the entry chunk.
// =============================================================================

export const DEFAULT_CHARTJS_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
export const DEFAULT_ADAPTER_URL = 'https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js';

/**
 * SRI hashes for the pinned default URLs. A custom `chartjsUrl` gets no
 * integrity attribute: we can't know its hash, and a wrong one would block it.
 */
export const DEFAULT_SRI: Readonly<Record<string, string>> = {
    [DEFAULT_CHARTJS_URL]: 'sha384-9nhczxUqK87bcKHh20fSQcTGD4qq5GhayNYSYWqwBkINBhOfQLg/P5HG5lF1urn4',
    [DEFAULT_ADAPTER_URL]: 'sha384-cVMg8E3QFwTvGCDuK+ET4PD341jF3W8nO1auiXfuZNQkzbUUiBGLsIQUE+b1mxws'
};
