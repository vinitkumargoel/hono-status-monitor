// =============================================================================
// HONO STATUS MONITOR - NODE DASHBOARD
// Full dashboard: system, health, process and cluster-worker cards.
// =============================================================================

import type { DashboardProps } from './types.js';
import { escapeHtml } from './format.js';
import {
    BASE_CSS,
    DEFAULT_CHARTJS_URL,
    DEFAULT_ADAPTER_URL,
    chartScriptTags,
    clientScript,
    inlineScriptOpen,
    THEME_BOOT_SCRIPT
} from './dashboard-assets.js';

/** Cards only the Node dashboard renders (system, health, process, workers). */
const NODE_CSS = `        .status-badge.connected { background: #dcfce7; color: #166534; }
        .status-badge.disconnected { background: #fee2e2; color: #991b1b; }
        .dark .status-badge.connected { background: #14532d; color: #86efac; }
        .dark .status-badge.disconnected { background: #7f1d1d; color: #fca5a5; }
        /* Process Info */
        .process-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
        .process-item { padding: 10px; background: var(--bg-secondary); border-radius: 6px; }
        .process-item .label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; }
        .process-item .value { font-size: 13px; font-weight: 500; margin-top: 2px; }

        @media (max-width: 640px) {
            .process-grid { grid-template-columns: repeat(2, 1fr); }
        }`;

/**
 * Generate the status dashboard HTML
 */
export function generateDashboard({
    hostname,
    uptime,
    title,
    pollingInterval = 1000,
    chartjsUrl = DEFAULT_CHARTJS_URL,
    chartAdapterUrl = DEFAULT_ADAPTER_URL,
    inlineCharts = false,
    nonce,
    stream = false,
    maxRoutes,
    maxRecentErrors,
    retentionSeconds
}: DashboardProps): string {
    const safeTitle = escapeHtml(title);
    const safeHostname = escapeHtml(hostname);
    const safeUptime = escapeHtml(uptime);
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${safeTitle}</title>
    ${inlineScriptOpen(nonce)}${THEME_BOOT_SCRIPT}</script>
    ${chartScriptTags(inlineCharts, chartjsUrl, chartAdapterUrl)}
    <style>
${BASE_CSS}
${NODE_CSS}
    </style>
</head>
<body>
    <main class="container">
        <header>
            <div class="title-section">
                <h1>${safeTitle}</h1>
                <div class="subtitle">${safeHostname}</div>
            </div>
            <div class="header-controls">
                <button class="theme-toggle" id="themeToggle" type="button" title="Toggle dark mode" aria-label="Toggle dark mode">🌓</button>
                <div class="status-badge connected" id="connBadge">
                    <span id="connText" aria-live="polite">Polling</span>
                </div>
            </div>
        </header>

        <div id="alertsLive" class="visually-hidden" role="status" aria-live="polite"></div>

        <div class="stats-bar">
            <div class="stat-box"><div class="label">Uptime</div><div class="value" id="uptime">${safeUptime}</div></div>
            <div class="stat-box"><div class="label">Requests</div><div class="value" id="totalReq">0</div></div>
            <div class="stat-box"><div class="label">Active</div><div class="value" id="activeConn">0</div></div>
            <div class="stat-box"><div class="label">Error Rate</div><div class="value" id="errorRate">0%</div></div>
        </div>

        <div class="percentiles">
            <div class="percentile-item"><div class="label">Avg</div><div class="value" id="pAvg">0ms</div></div>
            <div class="percentile-item"><div class="label">P50</div><div class="value" id="p50">0ms</div></div>
            <div class="percentile-item"><div class="label">P95</div><div class="value" id="p95">0ms</div></div>
            <div class="percentile-item"><div class="label">P99</div><div class="value" id="p99">0ms</div></div>
        </div>

                <div class="range-select" id="rangeSelect" role="group" aria-label="Chart time range" hidden></div>
        <div class="metric-row">     <div class="metric-info"><div class="metric-label">CPU</div><div class="metric-value"><span id="cpuVal">0</span><span class="metric-unit">%</span></div></div>
            <div class="chart-container"><canvas id="cpuChart" role="img" aria-label="CPU usage over time"></canvas></div>
        </div>
        <div class="metric-row">
            <div class="metric-info"><div class="metric-label">Memory</div><div class="metric-value"><span id="memVal">0</span><span class="metric-unit">MB</span></div></div>
            <div class="chart-container"><canvas id="memChart" role="img" aria-label="Memory usage over time"></canvas></div>
        </div>
        <div class="metric-row">
            <div class="metric-info"><div class="metric-label">Heap</div><div class="metric-value"><span id="heapVal">0</span><span class="metric-unit">MB</span></div></div>
            <div class="chart-container"><canvas id="heapChart" role="img" aria-label="Heap usage over time"></canvas></div>
        </div>
        <div class="metric-row">
            <div class="metric-info"><div class="metric-label">Load</div><div class="metric-value" id="loadVal">0.00</div></div>
            <div class="chart-container"><canvas id="loadChart" role="img" aria-label="Load average over time"></canvas></div>
        </div>
        <div class="metric-row">
            <div class="metric-info"><div class="metric-label">Response</div><div class="metric-value"><span id="rtVal">0</span><span class="metric-unit">ms</span></div></div>
            <div class="chart-container"><canvas id="rtChart" role="img" aria-label="Response time over time"></canvas></div>
        </div>
        <div class="metric-row">
            <div class="metric-info"><div class="metric-label">RPS</div><div class="metric-value" id="rpsVal">0</div></div>
            <div class="chart-container"><canvas id="rpsChart" role="img" aria-label="Requests per second over time"></canvas></div>
        </div>
        <div class="metric-row">
            <div class="metric-info"><div class="metric-label">Event Loop</div><div class="metric-value"><span id="lagVal">0</span><span class="metric-unit">ms</span></div></div>
            <div class="chart-container"><canvas id="lagChart" role="img" aria-label="Event loop lag over time"></canvas></div>
        </div>

        <h2 class="section-title">Route Analytics</h2>
        <div class="routes-grid">
            <div class="route-section">
                <h3>🔥 Top Routes</h3>
                <div id="topRoutes"><div class="route-item"><span class="route-path">No data yet</span></div></div>
            </div>
            <div class="route-section">
                <h3>🐢 Slowest Routes</h3>
                <div id="slowRoutes"><div class="route-item"><span class="route-path">No data yet</span></div></div>
            </div>
            <div class="route-section">
                <h3>💥 Error Routes</h3>
                <div id="errRoutes"><div class="route-item"><span class="route-path">No data yet</span></div></div>
            </div>
        </div>

        <h2 class="section-title" id="workersSection" style="display:none">Cluster Workers</h2>
        <div class="process-grid" id="workers" style="display:none"></div>

        <h2 class="section-title">HTTP Status Codes</h2>
        <div class="status-codes">
            <div class="status-code-box"><div class="code">2xx</div><div class="count s2xx" id="s2xx">0</div></div>
            <div class="status-code-box"><div class="code">3xx</div><div class="count s3xx" id="s3xx">0</div></div>
            <div class="status-code-box"><div class="code">4xx</div><div class="count s4xx" id="s4xx">0</div></div>
            <div class="status-code-box"><div class="code">5xx</div><div class="count s5xx" id="s5xx">0</div></div>
            <div class="status-code-box"><div class="code">Rate Limited</div><div class="count" id="rateLimited">0</div></div>
        </div>

        <h2 class="section-title">Recent Errors</h2>
        <div class="errors-panel" id="errorsPanel">
            <div style="color: var(--text-muted); font-size: 12px;">No errors recorded</div>
        </div>

        <h2 class="section-title">Health Checks</h2>
        <div class="health-grid" id="healthList">
            <div class="health-empty">Loading…</div>
        </div>

        <h2 class="section-title">Heap</h2>
        <div class="health-grid">
            <div class="health-item">
                <div class="label">Heap Total</div>
                <div class="value"><span id="heapTotal">0</span>MB</div>
            </div>
            <div class="health-item">
                <div class="label">Heap Growth</div>
                <div class="value"><span id="heapGrowth">0</span>MB/s</div>
            </div>
        </div>

        <h2 class="section-title">Process Info</h2>
        <div class="process-grid">
            <div class="process-item"><div class="label">Runtime</div><div class="value" id="nodeVer">-</div></div>
            <div class="process-item"><div class="label">Platform</div><div class="value" id="platform">-</div></div>
            <div class="process-item"><div class="label">PID</div><div class="value" id="pid">-</div></div>
            <div class="process-item"><div class="label">CPUs</div><div class="value" id="cpuCount">-</div></div>
        </div>
    </main>

    ${inlineScriptOpen(nonce)}
${clientScript(inlineCharts, pollingInterval, { stream, maxRoutes, maxRecentErrors, retentionSeconds })}
    </script>
</body>
</html>`;
}
