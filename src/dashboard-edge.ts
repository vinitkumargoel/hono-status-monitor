// =============================================================================
// HONO STATUS MONITOR - EDGE DASHBOARD
// Trimmed dashboard for edge isolates: no system, health or process cards.
// =============================================================================

import { escapeHtml } from './format.js';
import {
    BASE_CSS,
    DEFAULT_CHARTJS_URL,
    DEFAULT_ADAPTER_URL,
    chartScriptTags,
    clientScript,
    inlineScriptOpen
} from './dashboard-assets.js';

/** Edge-only banner and status badge. */
const EDGE_CSS = `        .status-badge.edge { background: #fff7ed; color: #c2410c; }
        .dark .status-badge.edge { background: #431407; color: #fdba74; }

        .edge-notice {
            background: linear-gradient(135deg, #fff7ed, #fef3c7);
            border: 1px solid #fed7aa;
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 16px;
            font-size: 12px;
            color: #9a3412;
        }
        .dark .edge-notice {
            background: linear-gradient(135deg, #431407, #422006);
            border-color: #c2410c;
            color: #fdba74;
        }
        .edge-notice strong { display: block; margin-bottom: 4px; }`;

export interface EdgeDashboardProps {
    hostname: string;
    uptime: string;
    title: string;
    pollingInterval?: number;
    chartjsUrl?: string;
    chartAdapterUrl?: string;
    inlineCharts?: boolean;
    /** Runtime name for the banner, e.g. "Cloudflare Workers" or "Deno". */
    platformLabel?: string;
    /** CSP nonce stamped on the inline client script. */
    nonce?: string;
}

/**
 * Generate the edge-mode status dashboard HTML
 */
export function generateEdgeDashboard({
    hostname,
    uptime,
    title,
    pollingInterval = 5000,
    chartjsUrl = DEFAULT_CHARTJS_URL,
    chartAdapterUrl = DEFAULT_ADAPTER_URL,
    inlineCharts = false,
    platformLabel = 'Cloudflare Workers',
    nonce
}: EdgeDashboardProps): string {
    const safeTitle = escapeHtml(title);
    const safeHostname = escapeHtml(hostname);
    const safeUptime = escapeHtml(uptime);
    const pollingSeconds = Math.round(pollingInterval / 1000);
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${safeTitle}</title>
    ${chartScriptTags(inlineCharts, chartjsUrl, chartAdapterUrl)}
    <style>
${BASE_CSS}
${EDGE_CSS}
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div class="title-section">
                <h1>${safeTitle}</h1>
                <div class="subtitle">${safeHostname}</div>
            </div>
            <div class="header-controls">
                <button class="theme-toggle" id="themeToggle" type="button" title="Toggle dark mode" aria-label="Toggle dark mode">🌓</button>
                <div class="status-badge edge" id="connBadge">
                    <span>☁️</span>
                    <span id="connText">Edge Mode</span>
                </div>
            </div>
        </header>

        <div class="edge-notice">
            <strong>☁️ Running in edge mode (${escapeHtml(platformLabel)})</strong>
            System metrics (CPU, Memory, Heap) are not available. Dashboard updates via polling every ${pollingSeconds} second${pollingSeconds !== 1 ? 's' : ''}.
        </div>

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

        <div class="metric-row">
            <div class="metric-info"><div class="metric-label">Response</div><div class="metric-value"><span id="rtVal">0</span><span class="metric-unit">ms</span></div></div>
            <div class="chart-container"><canvas id="rtChart"></canvas></div>
        </div>
        <div class="metric-row">
            <div class="metric-info"><div class="metric-label">RPS</div><div class="metric-value" id="rpsVal">0</div></div>
            <div class="chart-container"><canvas id="rpsChart"></canvas></div>
        </div>
        <div class="metric-row">
            <div class="metric-info"><div class="metric-label">Error Rate</div><div class="metric-value"><span id="errRateVal">0</span><span class="metric-unit">%</span></div></div>
            <div class="chart-container"><canvas id="errChart"></canvas></div>
        </div>

        <div class="section-title">Route Analytics</div>
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

        <div class="section-title">HTTP Status Codes</div>
        <div class="status-codes">
            <div class="status-code-box"><div class="code">2xx</div><div class="count s2xx" id="s2xx">0</div></div>
            <div class="status-code-box"><div class="code">3xx</div><div class="count s3xx" id="s3xx">0</div></div>
            <div class="status-code-box"><div class="code">4xx</div><div class="count s4xx" id="s4xx">0</div></div>
            <div class="status-code-box"><div class="code">5xx</div><div class="count s5xx" id="s5xx">0</div></div>
            <div class="status-code-box"><div class="code">Rate Limited</div><div class="count" id="rateLimited">0</div></div>
        </div>

        <div class="section-title">Recent Errors</div>
        <div class="errors-panel" id="errorsPanel">
            <div style="color: var(--text-muted); font-size: 12px;">No errors recorded</div>
        </div>

        <div class="section-title">Health Checks</div>
        <div class="health-grid" id="healthList">
            <div class="health-empty">Loading…</div>
        </div>
    </div>

    ${inlineScriptOpen(nonce)}
${clientScript(inlineCharts, pollingInterval)}
    </script>
</body>
</html>`;
}
