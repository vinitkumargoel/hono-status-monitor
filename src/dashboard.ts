// =============================================================================
// HONO STATUS MONITOR - DASHBOARD
// Real-time monitoring dashboard HTML generator
// =============================================================================

import type { DashboardProps } from './types.js';

/**
 * Generate the status dashboard HTML
 */
export function generateDashboard({ hostname, uptime, socketPath, title }: DashboardProps): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
    <style>
        :root {
            --bg: #fff;
            --bg-secondary: #f8f9fa;
            --bg-card: #fff;
            --border: #e5e5e5;
            --text: #111;
            --text-secondary: #666;
            --text-muted: #999;
            --accent: #3b82f6;
            --success: #10b981;
            --warning: #f59e0b;
            --danger: #ef4444;
        }
        
        .dark {
            --bg: #0f0f0f;
            --bg-secondary: #1a1a1a;
            --bg-card: #1a1a1a;
            --border: #2a2a2a;
            --text: #fafafa;
            --text-secondary: #a0a0a0;
            --text-muted: #666;
        }
        
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            background: var(--bg-secondary);
            color: var(--text);
            min-height: 100vh;
            transition: all 0.3s;
        }

        .container {
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background: var(--bg);
            min-height: 100vh;
            border-left: 1px solid var(--border);
            border-right: 1px solid var(--border);
        }

        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--border);
        }

        .title-section h1 { font-size: 18px; font-weight: 600; }
        .title-section .subtitle { font-size: 12px; color: var(--text-muted); margin-top: 2px; }

        .header-controls { display: flex; align-items: center; gap: 12px; }

        .theme-toggle {
            width: 36px; height: 36px;
            border: 1px solid var(--border);
            background: var(--bg-card);
            border-radius: 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
        }

        .status-badge {
            display: flex; align-items: center; gap: 6px;
            padding: 6px 12px; border-radius: 16px;
            font-size: 11px; font-weight: 500;
        }
        .status-badge.connected { background: #dcfce7; color: #166534; }
        .status-badge.disconnected { background: #fee2e2; color: #991b1b; }
        .dark .status-badge.connected { background: #14532d; color: #86efac; }
        .dark .status-badge.disconnected { background: #7f1d1d; color: #fca5a5; }

        /* Stats Bar */
        .stats-bar {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 8px;
            margin-bottom: 16px;
        }
        .stat-box {
            padding: 12px;
            background: var(--bg-secondary);
            border-radius: 8px;
            text-align: center;
        }
        .stat-box .label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
        .stat-box .value { font-size: 18px; font-weight: 600; margin-top: 4px; }

        /* Percentiles */
        .percentiles {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 8px;
            margin-bottom: 16px;
            padding: 12px;
            background: var(--bg-secondary);
            border-radius: 8px;
        }
        .percentile-item { text-align: center; }
        .percentile-item .label { font-size: 10px; color: var(--text-muted); }
        .percentile-item .value { font-size: 16px; font-weight: 600; color: var(--accent); }

        /* Metric Rows */
        .metric-row {
            display: flex; align-items: center;
            padding: 12px 0; border-bottom: 1px solid var(--border);
        }
        .metric-info { width: 140px; flex-shrink: 0; }
        .metric-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.3px; }
        .metric-value { font-size: 28px; font-weight: 300; line-height: 1.1; }
        .metric-unit { font-size: 14px; color: var(--text-muted); }
        .metric-alert { color: var(--danger) !important; }
        .chart-container { flex: 1; height: 50px; margin-left: 16px; }

        /* Section Titles */
        .section-title {
            font-size: 11px; font-weight: 600; color: var(--text-muted);
            text-transform: uppercase; letter-spacing: 0.5px;
            margin: 20px 0 12px; padding-top: 12px;
            border-top: 1px solid var(--border);
        }

        /* Route Tables */
        .routes-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
        .route-section { background: var(--bg-secondary); border-radius: 8px; padding: 12px; }
        .route-section h3 { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; }
        .route-item { display: flex; justify-content: space-between; font-size: 12px; padding: 6px 0; border-bottom: 1px solid var(--border); }
        .route-item:last-child { border-bottom: none; }
        .route-path { font-family: monospace; color: var(--text-secondary); max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
        .route-stat { font-weight: 500; }
        .route-stat.slow { color: var(--warning); }
        .route-stat.error { color: var(--danger); }

        /* Status Codes */
        .status-codes { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
        .status-code-box { text-align: center; padding: 10px; background: var(--bg-secondary); border-radius: 6px; }
        .status-code-box .code { font-size: 10px; color: var(--text-muted); }
        .status-code-box .count { font-size: 18px; font-weight: 600; margin-top: 2px; }
        .s2xx { color: var(--success); }
        .s3xx { color: var(--accent); }
        .s4xx { color: var(--warning); }
        .s5xx { color: var(--danger); }

        /* Errors Panel */
        .errors-panel { background: var(--bg-secondary); border-radius: 8px; padding: 12px; }
        .error-item { font-size: 12px; padding: 8px; background: var(--bg-card); border-radius: 4px; margin-top: 6px; border-left: 3px solid var(--danger); }
        .error-item:first-of-type { margin-top: 0; }
        .error-time { font-size: 10px; color: var(--text-muted); }
        .error-path { font-family: monospace; color: var(--danger); }

        /* Database & Health */
        .health-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
        .health-item { padding: 12px; background: var(--bg-secondary); border-radius: 8px; text-align: center; }
        .health-item .label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; }
        .health-item .value { font-size: 16px; font-weight: 600; margin-top: 4px; }
        .health-item .status { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; margin-top: 4px; }
        .health-item .status.ok { background: #dcfce7; color: #166534; }
        .health-item .status.error { background: #fee2e2; color: #991b1b; }
        .dark .health-item .status.ok { background: #14532d; color: #86efac; }
        .dark .health-item .status.error { background: #7f1d1d; color: #fca5a5; }

        /* Process Info */
        .process-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
        .process-item { padding: 10px; background: var(--bg-secondary); border-radius: 6px; }
        .process-item .label { font-size: 9px; color: var(--text-muted); text-transform: uppercase; }
        .process-item .value { font-size: 13px; font-weight: 500; margin-top: 2px; }

        @media (max-width: 640px) {
            .container { padding: 12px; }
            .stats-bar, .percentiles { grid-template-columns: repeat(2, 1fr); }
            .routes-grid { grid-template-columns: 1fr; }
            .status-codes { grid-template-columns: repeat(3, 1fr); }
            .health-grid, .process-grid { grid-template-columns: repeat(2, 1fr); }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div class="title-section">
                <h1>${title}</h1>
                <div class="subtitle">${hostname}</div>
            </div>
            <div class="header-controls">
                <button class="theme-toggle" onclick="toggleTheme()" title="Toggle dark mode">🌓</button>
                <div class="status-badge connected" id="connBadge">
                    <span id="connText">Polling</span>
                </div>
            </div>
        </header>

        <div class="stats-bar">
            <div class="stat-box"><div class="label">Uptime</div><div class="value" id="uptime">${uptime}</div></div>
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
            <div class="metric-info"><div class="metric-label">CPU</div><div class="metric-value"><span id="cpuVal">0</span><span class="metric-unit">%</span></div></div>
            <div class="chart-container"><canvas id="cpuChart"></canvas></div>
        </div>
        <div class="metric-row">
            <div class="metric-info"><div class="metric-label">Memory</div><div class="metric-value"><span id="memVal">0</span><span class="metric-unit">MB</span></div></div>
            <div class="chart-container"><canvas id="memChart"></canvas></div>
        </div>
        <div class="metric-row">
            <div class="metric-info"><div class="metric-label">Heap</div><div class="metric-value"><span id="heapVal">0</span><span class="metric-unit">MB</span></div></div>
            <div class="chart-container"><canvas id="heapChart"></canvas></div>
        </div>
        <div class="metric-row">
            <div class="metric-info"><div class="metric-label">Load</div><div class="metric-value" id="loadVal">0.00</div></div>
            <div class="chart-container"><canvas id="loadChart"></canvas></div>
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
            <div class="metric-info"><div class="metric-label">Event Loop</div><div class="metric-value"><span id="lagVal">0</span><span class="metric-unit">ms</span></div></div>
            <div class="chart-container"><canvas id="lagChart"></canvas></div>
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
        <div class="health-grid">
            <div class="health-item">
                <div class="label">Database</div>
                <div class="value" id="dbLatency">-</div>
                <div class="status" id="dbStatus">-</div>
            </div>
            <div class="health-item">
                <div class="label">Heap Total</div>
                <div class="value"><span id="heapTotal">0</span>MB</div>
            </div>
            <div class="health-item">
                <div class="label">Heap Growth</div>
                <div class="value"><span id="heapGrowth">0</span>MB/s</div>
            </div>
        </div>

        <div class="section-title">Process Info</div>
        <div class="process-grid">
            <div class="process-item"><div class="label">Node</div><div class="value" id="nodeVer">-</div></div>
            <div class="process-item"><div class="label">Platform</div><div class="value" id="platform">-</div></div>
            <div class="process-item"><div class="label">PID</div><div class="value" id="pid">-</div></div>
            <div class="process-item"><div class="label">CPUs</div><div class="value" id="cpuCount">-</div></div>
        </div>
    </div>

    <script>
        (function() {
            var isDark = localStorage.getItem('statusDark') === 'true';
            if (isDark) document.body.classList.add('dark');

            window.toggleTheme = function() {
                document.body.classList.toggle('dark');
                localStorage.setItem('statusDark', document.body.classList.contains('dark'));
            };

            var gridColor = isDark ? '#2a2a2a' : '#f0f0f0';

            var chartConfig = {
                responsive: true, maintainAspectRatio: false, animation: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { type: 'time', time: { unit: 'second' }, grid: { display: false }, ticks: { display: false } },
                    y: { beginAtZero: true, grid: { color: gridColor, drawBorder: false }, ticks: { font: { size: 9 }, color: '#999', maxTicksLimit: 3 } }
                },
                elements: { point: { radius: 0 }, line: { tension: 0.2, borderWidth: 1.5 } }
            };

            function createChart(id, color) {
                var ctx = document.getElementById(id).getContext('2d');
                var config = JSON.parse(JSON.stringify(chartConfig));
                return new Chart(ctx, { type: 'line', data: { datasets: [{ data: [], borderColor: color, fill: false }] }, options: config });
            }

            var charts = {
                cpu: createChart('cpuChart', '#3b82f6'),
                mem: createChart('memChart', '#8b5cf6'),
                heap: createChart('heapChart', '#a855f7'),
                load: createChart('loadChart', '#f59e0b'),
                rt: createChart('rtChart', '#10b981'),
                rps: createChart('rpsChart', '#ec4899'),
                lag: createChart('lagChart', '#ef4444')
            };

            function updateChart(chart, points) {
                chart.data.datasets[0].data = points.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; });
                chart.update('none');
            }

            function formatUptime(s) {
                var d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60), parts=[];
                if(d)parts.push(d+'d'); if(h)parts.push(h+'h'); if(m)parts.push(m+'m'); parts.push((s%60)+'s');
                return parts.join(' ');
            }

            function sumCodes(codes, prefix) { var sum=0; for(var c in codes) if(c.startsWith(prefix)) sum+=codes[c]; return sum; }

            function renderRoutes(containerId, routes, statKey, isSlow) {
                var container = document.getElementById(containerId);
                if (!routes || routes.length === 0) { container.innerHTML = '<div class="route-item"><span class="route-path">No data yet</span></div>'; return; }
                container.innerHTML = routes.slice(0,5).map(function(r) {
                    var val = statKey === 'avgTime' ? r.avgTime.toFixed(1) + 'ms' : (statKey === 'errors' ? r.errors : r.count);
                    var cls = isSlow && r.avgTime > 100 ? 'slow' : (statKey === 'errors' ? 'error' : '');
                    return '<div class="route-item"><span class="route-path">' + r.method + ' ' + r.path + '</span><span class="route-stat ' + cls + '">' + val + '</span></div>';
                }).join('');
            }

            function renderErrors(errors) {
                var panel = document.getElementById('errorsPanel');
                if (!errors || errors.length === 0) { panel.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No errors recorded</div>'; return; }
                panel.innerHTML = errors.slice(0,5).map(function(e) {
                    return '<div class="error-item"><div class="error-time">' + new Date(e.timestamp).toLocaleTimeString() + '</div><div class="error-path">' + e.method + ' ' + e.path + ' → ' + e.status + '</div></div>';
                }).join('');
            }

            function applyAlertColors(alerts) {
                document.getElementById('cpuVal').style.color = alerts.cpu ? 'var(--danger)' : '';
                document.getElementById('rtVal').style.color = alerts.responseTime ? 'var(--danger)' : '';
                document.getElementById('lagVal').style.color = alerts.eventLoopLag ? 'var(--danger)' : '';
                document.getElementById('errorRate').style.color = alerts.errorRate ? 'var(--danger)' : '';
            }

            function fetchMetrics() {
                fetch('./api/metrics')
                    .then(function(res) { return res.json(); })
                    .then(function(data) {
                        var s = data.snapshot, c = data.charts;

                        document.getElementById('cpuVal').textContent = s.cpu.toFixed(1);
                        document.getElementById('memVal').textContent = s.memoryMB.toFixed(0);
                        document.getElementById('heapVal').textContent = s.heapUsedMB.toFixed(1);
                        document.getElementById('loadVal').textContent = s.loadAvg.toFixed(2);
                        document.getElementById('rtVal').textContent = s.responseTime.toFixed(1);
                        document.getElementById('rpsVal').textContent = s.rps.toFixed(1);
                        document.getElementById('lagVal').textContent = s.eventLoopLag.toFixed(1);

                        document.getElementById('uptime').textContent = formatUptime(s.processUptime);
                        document.getElementById('totalReq').textContent = s.totalRequests.toLocaleString();
                        document.getElementById('activeConn').textContent = s.activeConnections;
                        document.getElementById('errorRate').textContent = s.errorRate.toFixed(1) + '%';

                        document.getElementById('pAvg').textContent = s.percentiles.avg.toFixed(1) + 'ms';
                        document.getElementById('p50').textContent = s.percentiles.p50.toFixed(1) + 'ms';
                        document.getElementById('p95').textContent = s.percentiles.p95.toFixed(1) + 'ms';
                        document.getElementById('p99').textContent = s.percentiles.p99.toFixed(1) + 'ms';

                        if (c.cpu) updateChart(charts.cpu, c.cpu);
                        if (c.memory) updateChart(charts.mem, c.memory);
                        if (c.heap) updateChart(charts.heap, c.heap);
                        if (c.loadAvg) updateChart(charts.load, c.loadAvg);
                        if (c.responseTime) updateChart(charts.rt, c.responseTime);
                        if (c.rps) updateChart(charts.rps, c.rps);
                        if (c.eventLoopLag) updateChart(charts.lag, c.eventLoopLag);

                        renderRoutes('topRoutes', s.topRoutes, 'count', false);
                        renderRoutes('slowRoutes', s.slowestRoutes, 'avgTime', true);

                        document.getElementById('s2xx').textContent = sumCodes(s.statusCodes, '2');
                        document.getElementById('s3xx').textContent = sumCodes(s.statusCodes, '3');
                        document.getElementById('s4xx').textContent = sumCodes(s.statusCodes, '4');
                        document.getElementById('s5xx').textContent = sumCodes(s.statusCodes, '5');
                        document.getElementById('rateLimited').textContent = s.rateLimitStats.blocked;

                        renderErrors(s.recentErrors);
                        applyAlertColors(s.alerts);

                        document.getElementById('dbLatency').textContent = s.database.latencyMs.toFixed(1) + 'ms';
                        document.getElementById('dbStatus').textContent = s.database.connected ? 'Connected' : 'Disconnected';
                        document.getElementById('dbStatus').className = 'status ' + (s.database.connected ? 'ok' : 'error');
                        document.getElementById('heapTotal').textContent = s.heapTotalMB.toFixed(0);
                        document.getElementById('heapGrowth').textContent = s.gc.heapGrowthRate.toFixed(2);

                        document.getElementById('nodeVer').textContent = s.nodeVersion;
                        document.getElementById('platform').textContent = s.platform.split(' ')[0];
                        document.getElementById('pid').textContent = s.pid;
                        document.getElementById('cpuCount').textContent = s.cpuCount;
                    })
                    .catch(function(err) {
                        console.error('Failed to fetch metrics:', err);
                    });
            }

            // Initial fetch
            fetchMetrics();

            // Poll every second
            setInterval(fetchMetrics, 1000);
        })();
    </script>
</body>
</html>`;
}


/**
 * Edge Dashboard Props (no socketPath)
 */
export interface EdgeDashboardProps {
    hostname: string;
    uptime: string;
    title: string;
}

/**
 * Generate the edge-compatible status dashboard HTML
 * Uses polling instead of WebSocket, only shows available metrics
 */
export function generateEdgeDashboard({ hostname, uptime, title }: EdgeDashboardProps): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
    <style>
        :root {
            --bg: #fff;
            --bg-secondary: #f8f9fa;
            --bg-card: #fff;
            --border: #e5e5e5;
            --text: #111;
            --text-secondary: #666;
            --text-muted: #999;
            --accent: #3b82f6;
            --success: #10b981;
            --warning: #f59e0b;
            --danger: #ef4444;
            --edge: #f97316;
        }
        
        .dark {
            --bg: #0f0f0f;
            --bg-secondary: #1a1a1a;
            --bg-card: #1a1a1a;
            --border: #2a2a2a;
            --text: #fafafa;
            --text-secondary: #a0a0a0;
            --text-muted: #666;
        }
        
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            background: var(--bg-secondary);
            color: var(--text);
            min-height: 100vh;
            transition: all 0.3s;
        }

        .container {
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background: var(--bg);
            min-height: 100vh;
            border-left: 1px solid var(--border);
            border-right: 1px solid var(--border);
        }

        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--border);
        }

        .title-section h1 { font-size: 18px; font-weight: 600; }
        .title-section .subtitle { font-size: 12px; color: var(--text-muted); margin-top: 2px; }

        .header-controls { display: flex; align-items: center; gap: 12px; }

        .theme-toggle {
            width: 36px; height: 36px;
            border: 1px solid var(--border);
            background: var(--bg-card);
            border-radius: 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
        }

        .status-badge {
            display: flex; align-items: center; gap: 6px;
            padding: 6px 12px; border-radius: 16px;
            font-size: 11px; font-weight: 500;
        }
        .status-badge.edge { background: #fff7ed; color: #c2410c; }
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
        .edge-notice strong { display: block; margin-bottom: 4px; }

        /* Stats Bar */
        .stats-bar {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 8px;
            margin-bottom: 16px;
        }
        .stat-box {
            padding: 12px;
            background: var(--bg-secondary);
            border-radius: 8px;
            text-align: center;
        }
        .stat-box .label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
        .stat-box .value { font-size: 18px; font-weight: 600; margin-top: 4px; }

        /* Percentiles */
        .percentiles {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 8px;
            margin-bottom: 16px;
            padding: 12px;
            background: var(--bg-secondary);
            border-radius: 8px;
        }
        .percentile-item { text-align: center; }
        .percentile-item .label { font-size: 10px; color: var(--text-muted); }
        .percentile-item .value { font-size: 16px; font-weight: 600; color: var(--accent); }

        /* Metric Rows */
        .metric-row {
            display: flex; align-items: center;
            padding: 12px 0; border-bottom: 1px solid var(--border);
        }
        .metric-info { width: 140px; flex-shrink: 0; }
        .metric-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.3px; }
        .metric-value { font-size: 28px; font-weight: 300; line-height: 1.1; }
        .metric-unit { font-size: 14px; color: var(--text-muted); }
        .metric-alert { color: var(--danger) !important; }
        .chart-container { flex: 1; height: 50px; margin-left: 16px; }

        /* Section Titles */
        .section-title {
            font-size: 11px; font-weight: 600; color: var(--text-muted);
            text-transform: uppercase; letter-spacing: 0.5px;
            margin: 20px 0 12px; padding-top: 12px;
            border-top: 1px solid var(--border);
        }

        /* Route Tables */
        .routes-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
        .route-section { background: var(--bg-secondary); border-radius: 8px; padding: 12px; }
        .route-section h3 { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; }
        .route-item { display: flex; justify-content: space-between; font-size: 12px; padding: 6px 0; border-bottom: 1px solid var(--border); }
        .route-item:last-child { border-bottom: none; }
        .route-path { font-family: monospace; color: var(--text-secondary); max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
        .route-stat { font-weight: 500; }
        .route-stat.slow { color: var(--warning); }
        .route-stat.error { color: var(--danger); }

        /* Status Codes */
        .status-codes { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
        .status-code-box { text-align: center; padding: 10px; background: var(--bg-secondary); border-radius: 6px; }
        .status-code-box .code { font-size: 10px; color: var(--text-muted); }
        .status-code-box .count { font-size: 18px; font-weight: 600; margin-top: 2px; }
        .s2xx { color: var(--success); }
        .s3xx { color: var(--accent); }
        .s4xx { color: var(--warning); }
        .s5xx { color: var(--danger); }

        /* Errors Panel */
        .errors-panel { background: var(--bg-secondary); border-radius: 8px; padding: 12px; }
        .error-item { font-size: 12px; padding: 8px; background: var(--bg-card); border-radius: 4px; margin-top: 6px; border-left: 3px solid var(--danger); }
        .error-item:first-of-type { margin-top: 0; }
        .error-time { font-size: 10px; color: var(--text-muted); }
        .error-path { font-family: monospace; color: var(--danger); }

        @media (max-width: 640px) {
            .container { padding: 12px; }
            .stats-bar, .percentiles { grid-template-columns: repeat(2, 1fr); }
            .routes-grid { grid-template-columns: 1fr; }
            .status-codes { grid-template-columns: repeat(3, 1fr); }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div class="title-section">
                <h1>${title}</h1>
                <div class="subtitle">${hostname}</div>
            </div>
            <div class="header-controls">
                <button class="theme-toggle" onclick="toggleTheme()" title="Toggle dark mode">🌓</button>
                <div class="status-badge edge" id="connBadge">
                    <span>☁️</span>
                    <span id="connText">Edge Mode</span>
                </div>
            </div>
        </header>

        <div class="edge-notice">
            <strong>☁️ Running in Edge/Cloudflare Workers Mode</strong>
            System metrics (CPU, Memory, Heap) are not available. Dashboard updates via polling every 5 seconds.
        </div>

        <div class="stats-bar">
            <div class="stat-box"><div class="label">Uptime</div><div class="value" id="uptime">${uptime}</div></div>
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
    </div>

    <script>
        (function() {
            var isDark = localStorage.getItem('statusDark') === 'true';
            if (isDark) document.body.classList.add('dark');

            window.toggleTheme = function() {
                document.body.classList.toggle('dark');
                localStorage.setItem('statusDark', document.body.classList.contains('dark'));
            };

            var gridColor = isDark ? '#2a2a2a' : '#f0f0f0';

            var chartConfig = {
                responsive: true, maintainAspectRatio: false, animation: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { type: 'time', time: { unit: 'second' }, grid: { display: false }, ticks: { display: false } },
                    y: { beginAtZero: true, grid: { color: gridColor, drawBorder: false }, ticks: { font: { size: 9 }, color: '#999', maxTicksLimit: 3 } }
                },
                elements: { point: { radius: 0 }, line: { tension: 0.2, borderWidth: 1.5 } }
            };

            function createChart(id, color) {
                var ctx = document.getElementById(id).getContext('2d');
                var config = JSON.parse(JSON.stringify(chartConfig));
                return new Chart(ctx, { type: 'line', data: { datasets: [{ data: [], borderColor: color, fill: false }] }, options: config });
            }

            var charts = {
                rt: createChart('rtChart', '#10b981'),
                rps: createChart('rpsChart', '#ec4899'),
                err: createChart('errChart', '#ef4444')
            };

            function updateChart(chart, points) {
                chart.data.datasets[0].data = points.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; });
                chart.update('none');
            }

            function formatUptime(s) {
                var d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60), parts=[];
                if(d)parts.push(d+'d'); if(h)parts.push(h+'h'); if(m)parts.push(m+'m'); parts.push((s%60)+'s');
                return parts.join(' ');
            }

            function sumCodes(codes, prefix) { var sum=0; for(var c in codes) if(c.startsWith(prefix)) sum+=codes[c]; return sum; }

            function renderRoutes(containerId, routes, statKey, isSlow) {
                var container = document.getElementById(containerId);
                if (!routes || routes.length === 0) { container.innerHTML = '<div class="route-item"><span class="route-path">No data yet</span></div>'; return; }
                container.innerHTML = routes.slice(0,5).map(function(r) {
                    var val = statKey === 'avgTime' ? r.avgTime.toFixed(1) + 'ms' : (statKey === 'errors' ? r.errors : r.count);
                    var cls = isSlow && r.avgTime > 100 ? 'slow' : (statKey === 'errors' ? 'error' : '');
                    return '<div class="route-item"><span class="route-path">' + r.method + ' ' + r.path + '</span><span class="route-stat ' + cls + '">' + val + '</span></div>';
                }).join('');
            }

            function renderErrors(errors) {
                var panel = document.getElementById('errorsPanel');
                if (!errors || errors.length === 0) { panel.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No errors recorded</div>'; return; }
                panel.innerHTML = errors.slice(0,5).map(function(e) {
                    return '<div class="error-item"><div class="error-time">' + new Date(e.timestamp).toLocaleTimeString() + '</div><div class="error-path">' + e.method + ' ' + e.path + ' → ' + e.status + '</div></div>';
                }).join('');
            }

            function applyAlertColors(alerts) {
                document.getElementById('rtVal').style.color = alerts.responseTime ? 'var(--danger)' : '';
                document.getElementById('errorRate').style.color = alerts.errorRate ? 'var(--danger)' : '';
            }

            function fetchMetrics() {
                fetch('./api/metrics')
                    .then(function(res) { return res.json(); })
                    .then(function(data) {
                        var s = data.snapshot, c = data.charts;

                        document.getElementById('rtVal').textContent = s.responseTime.toFixed(1);
                        document.getElementById('rpsVal').textContent = s.rps.toFixed(1);
                        document.getElementById('errRateVal').textContent = s.errorRate.toFixed(1);

                        document.getElementById('uptime').textContent = formatUptime(s.processUptime);
                        document.getElementById('totalReq').textContent = s.totalRequests.toLocaleString();
                        document.getElementById('activeConn').textContent = s.activeConnections;
                        document.getElementById('errorRate').textContent = s.errorRate.toFixed(1) + '%';

                        document.getElementById('pAvg').textContent = s.percentiles.avg.toFixed(1) + 'ms';
                        document.getElementById('p50').textContent = s.percentiles.p50.toFixed(1) + 'ms';
                        document.getElementById('p95').textContent = s.percentiles.p95.toFixed(1) + 'ms';
                        document.getElementById('p99').textContent = s.percentiles.p99.toFixed(1) + 'ms';

                        if (c.responseTime) updateChart(charts.rt, c.responseTime);
                        if (c.rps) updateChart(charts.rps, c.rps);
                        if (c.errorRate) updateChart(charts.err, c.errorRate);

                        renderRoutes('topRoutes', s.topRoutes, 'count', false);
                        renderRoutes('slowRoutes', s.slowestRoutes, 'avgTime', true);

                        document.getElementById('s2xx').textContent = sumCodes(s.statusCodes, '2');
                        document.getElementById('s3xx').textContent = sumCodes(s.statusCodes, '3');
                        document.getElementById('s4xx').textContent = sumCodes(s.statusCodes, '4');
                        document.getElementById('s5xx').textContent = sumCodes(s.statusCodes, '5');
                        document.getElementById('rateLimited').textContent = s.rateLimitStats.blocked;

                        renderErrors(s.recentErrors);
                        applyAlertColors(s.alerts);
                    })
                    .catch(function(err) {
                        console.error('Failed to fetch metrics:', err);
                    });
            }

            // Initial fetch
            fetchMetrics();

            // Poll every 5 seconds
            setInterval(fetchMetrics, 5000);
        })();
    </script>
</body>
</html>`;
}

