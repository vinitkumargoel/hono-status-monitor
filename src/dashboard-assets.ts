// =============================================================================
// HONO STATUS MONITOR - SHARED DASHBOARD ASSETS
// Stylesheet base and client script shared by the Node and edge dashboards.
//
// Kept in its own module so the edge bundle pulls only these shared bytes plus
// its own markup — the Node-only stylesheet lives in dashboard.ts and never
// reaches an edge build.
// =============================================================================

import { escapeHtml } from './format.js';
import { DEFAULT_CHARTJS_URL, DEFAULT_ADAPTER_URL, DEFAULT_SRI } from './chart-cdn.js';

export { DEFAULT_CHARTJS_URL, DEFAULT_ADAPTER_URL };

/** Styles common to both dashboards. */
export const BASE_CSS = `        :root {
            --bg: #fff;
            --edge: #f97316;
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

        .status-badge.stale { background: #fef3c7; color: #92400e; }
        .status-badge.down { background: #fee2e2; color: #991b1b; }
        .dark .status-badge.stale { background: #422006; color: #fcd34d; }
        .dark .status-badge.down { background: #7f1d1d; color: #fca5a5; }

        /* Health checks */
        .health-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
        .health-item { padding: 12px; background: var(--bg-secondary); border-radius: 8px; text-align: center; }
        .health-item .label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; overflow: hidden; text-overflow: ellipsis; }
        .health-item .value { font-size: 16px; font-weight: 600; margin-top: 4px; }
        .health-item .status { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; margin-top: 4px; }
        .health-item .status.ok { background: #dcfce7; color: #166534; }
        .health-item .status.error { background: #fee2e2; color: #991b1b; }
        .dark .health-item .status.ok { background: #14532d; color: #86efac; }
        .dark .health-item .status.error { background: #7f1d1d; color: #fca5a5; }
        .health-empty { grid-column: 1 / -1; font-size: 12px; color: var(--text-muted); }

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
            .health-grid { grid-template-columns: repeat(2, 1fr); }
        }`;

/**
 * The dashboard client, shared by both variants.
 *
 * Every DOM read is optional: `setText`, `setDanger` and `createChart` no-op when
 * the element is absent, so Node-only cards simply do not update on edge.
 */
export function clientScript(inlineCharts: boolean, pollingInterval: number): string {
    return `        (function() {
            var isDark = localStorage.getItem('statusDark') === 'true';
            if (isDark) document.body.classList.add('dark');

            window.toggleTheme = function() {
                document.body.classList.toggle('dark');
                localStorage.setItem('statusDark', document.body.classList.contains('dark'));
            };
            // Bound here rather than via an onclick attribute, which a nonce-based
            // CSP would block.
            var themeBtn = document.getElementById('themeToggle');
            if (themeBtn) themeBtn.addEventListener('click', window.toggleTheme);

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

            // Dependency-free inline renderer (no Chart.js / no CDN) when INLINE is true.
            var INLINE = ${inlineCharts ? 'true' : 'false'};
            // If the Chart.js CDN is blocked (offline, CSP, corporate proxy) fall
            // back to the inline renderer instead of throwing on the first chart
            // and leaving every card at zero.
            if (!INLINE && typeof Chart === 'undefined') {
                INLINE = true;
                console.warn('[status] Chart.js did not load; using the built-in chart renderer.');
            }

            // This script is shared by the Node and edge dashboards, which render
            // different subsets of cards AND report different subsets of metrics.
            // Both are therefore optional: helpers no-op when the element is
            // absent, and render an em dash when the value is missing, rather
            // than throwing. A throw here would be caught by the fetch handler
            // and silently freeze every card on the page.
            function setText(id, value) {
                var el = document.getElementById(id);
                if (el) el.textContent = value;
            }

            // Numeric setter: tolerates a field the running platform doesn't report.
            function setNum(id, value, digits, suffix) {
                var el = document.getElementById(id);
                if (!el) return;
                el.textContent = (typeof value === 'number' && isFinite(value))
                    ? value.toFixed(digits) + (suffix || '')
                    : '\\u2014';
            }

            function setDanger(id, active) {
                var el = document.getElementById(id);
                if (el) el.style.color = active ? 'var(--danger)' : '';
            }

            function drawSpark(chart, points) {
                var canvas = chart.canvas;
                if (!canvas) return;
                var w = canvas.clientWidth || 200, h = canvas.clientHeight || 50;
                var dpr = window.devicePixelRatio || 1;
                canvas.width = Math.max(1, Math.round(w * dpr));
                canvas.height = Math.max(1, Math.round(h * dpr));
                var ctx = canvas.getContext('2d');
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.clearRect(0, 0, w, h);
                if (!points || points.length === 0) return;
                var min = Infinity, max = -Infinity;
                for (var i = 0; i < points.length; i++) { var v = points[i].value; if (v < min) min = v; if (v > max) max = v; }
                if (max === min) { max = min + 1; }
                var pad = 3;
                ctx.beginPath();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = chart.color;
                for (var j = 0; j < points.length; j++) {
                    var x = pad + (w - 2 * pad) * (points.length === 1 ? 0 : j / (points.length - 1));
                    var y = h - pad - (h - 2 * pad) * ((points[j].value - min) / (max - min));
                    if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }

            function inlineChart(el, color) { return { inline: true, canvas: el, color: color }; }

            function createChart(id, color) {
                var el = document.getElementById(id);
                if (!el) return null;
                if (INLINE) return inlineChart(el, color);
                try {
                    var config = JSON.parse(JSON.stringify(chartConfig));
                    var chart = new Chart(el.getContext('2d'), { type: 'line', data: { datasets: [{ data: [], borderColor: color, fill: false }] }, options: config });
                    chart.hsmColor = color;
                    return chart;
                } catch (e) {
                    // e.g. Chart.js loaded but its date adapter did not.
                    return inlineChart(el, color);
                }
            }

            // Canvases absent from this variant's markup yield null and are skipped.
            var charts = {
                cpu: createChart('cpuChart', '#3b82f6'),
                mem: createChart('memChart', '#8b5cf6'),
                heap: createChart('heapChart', '#a855f7'),
                load: createChart('loadChart', '#f59e0b'),
                rt: createChart('rtChart', '#10b981'),
                rps: createChart('rpsChart', '#ec4899'),
                lag: createChart('lagChart', '#ef4444'),
                err: createChart('errChart', '#ef4444')
            };

            function updateChart(key, points) {
                var chart = charts[key];
                if (!chart || !points) return;
                if (chart.inline) { drawSpark(chart, points); return; }
                try {
                    chart.data.datasets[0].data = points.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; });
                    chart.update('none');
                } catch (e) {
                    // Chart.js failed mid-flight; swap this chart to the inline renderer.
                    try { chart.destroy(); } catch (_) {}
                    charts[key] = inlineChart(chart.canvas, chart.hsmColor);
                    drawSpark(charts[key], points);
                }
            }

            function formatUptime(s) {
                if (typeof s !== 'number' || !isFinite(s)) return '\\u2014';
                var d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60), parts=[];
                if(d)parts.push(d+'d'); if(h)parts.push(h+'h'); if(m)parts.push(m+'m'); parts.push((s%60)+'s');
                return parts.join(' ');
            }

            function sumCodes(codes, prefix) { var sum=0; for(var c in codes) if(c.startsWith(prefix)) sum+=codes[c]; return sum; }

            // Format a number for interpolation into markup, tolerating absent fields.
            function fx(v, digits) {
                return (typeof v === 'number' && isFinite(v)) ? v.toFixed(digits) : '\\u2014';
            }

            // Escape untrusted values (route paths, methods) before inserting as HTML.
            function esc(v) {
                return String(v == null ? '' : v)
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            }

            function renderRoutes(containerId, routes, statKey, isSlow) {
                var container = document.getElementById(containerId);
                if (!container) return;
                if (!routes || routes.length === 0) { container.innerHTML = '<div class="route-item"><span class="route-path">No data yet</span></div>'; return; }
                container.innerHTML = routes.slice(0,5).map(function(r) {
                    var val = statKey === 'avgTime' ? fx(r.avgTime, 1) + 'ms' : (statKey === 'errors' ? r.errors : r.count);
                    var cls = isSlow && r.avgTime > 100 ? 'slow' : (statKey === 'errors' ? 'error' : '');
                    return '<div class="route-item"><span class="route-path">' + esc(r.method) + ' ' + esc(r.path) + '</span><span class="route-stat ' + cls + '">' + esc(val) + '</span></div>';
                }).join('');
            }

            function renderWorkers(workers) {
                var container = document.getElementById('workers');
                var section = document.getElementById('workersSection');
                if (!container || !section) return;
                if (!workers || workers.length === 0) { section.style.display = 'none'; return; }
                section.style.display = '';
                container.innerHTML = workers.map(function(w) {
                    return '<div class="process-item"><div class="label">PID ' + esc(w.pid) + '</div><div class="value">' + fx(w.rps, 1) + ' rps · ' + fx(w.cpu, 0) + '% · ' + fx(w.responseTime, 0) + 'ms</div></div>';
                }).join('');
            }

            function renderErrors(errors) {
                var panel = document.getElementById('errorsPanel');
                if (!panel) return;
                if (!errors || errors.length === 0) { panel.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No errors recorded</div>'; return; }
                panel.innerHTML = errors.slice(0,5).map(function(e) {
                    return '<div class="error-item"><div class="error-time">' + esc(new Date(e.timestamp).toLocaleTimeString()) + '</div><div class="error-path">' + esc(e.method) + ' ' + esc(e.path) + ' → ' + esc(e.status) + '</div></div>';
                }).join('');
            }

            function renderHealth(health) {
                var el = document.getElementById('healthList');
                if (!el || !health || !health.checks) return;
                if (health.configured === false) {
                    el.innerHTML = '<div class="health-empty">No health checks configured</div>';
                    return;
                }
                el.innerHTML = health.checks.map(function(c) {
                    return '<div class="health-item"><div class="label" title="' + esc(c.name) + '">' + esc(c.name) + '</div>' +
                        '<div class="value">' + fx(c.latencyMs, 1) + 'ms</div>' +
                        '<div class="status ' + (c.connected ? 'ok' : 'error') + '">' + (c.connected ? 'Healthy' : 'Down') + '</div></div>';
                }).join('');
            }

            // Connection badge: Live / Stale / Unauthorized / Offline, so a failing
            // poll is visible instead of stale numbers passing for live ones.
            var badge = document.getElementById('connBadge');
            var badgeText = document.getElementById('connText');
            var liveClass = badge ? badge.className : 'status-badge';
            function setBadge(state, text, title) {
                if (badge) badge.className = state === 'live' ? liveClass : 'status-badge ' + state;
                if (badgeText) badgeText.textContent = text;
                if (badge) badge.title = title || '';
            }

            function applyAlertColors(alerts) {
                setDanger('cpuVal', alerts.cpu);
                setDanger('rtVal', alerts.responseTime);
                setDanger('lagVal', alerts.eventLoopLag);
                setDanger('errorRate', alerts.errorRate);
            }

            function render(data) {
                var s = data.snapshot, c = data.charts || {};
                var pct = s.percentiles || {};

                setNum('cpuVal', s.cpu, 1);
                setNum('memVal', s.memoryMB, 0);
                setNum('heapVal', s.heapUsedMB, 1);
                setNum('loadVal', s.loadAvg, 2);
                setNum('rtVal', s.responseTime, 1);
                setNum('rpsVal', s.rps, 1);
                setNum('lagVal', s.eventLoopLag, 1);
                setNum('errRateVal', s.errorRate, 1);

                setText('uptime', formatUptime(s.processUptime));
                setText('totalReq', typeof s.totalRequests === 'number' ? s.totalRequests.toLocaleString() : '\\u2014');
                setText('activeConn', s.activeConnections);
                setNum('errorRate', s.errorRate, 1, '%');

                setNum('pAvg', pct.avg, 1, 'ms');
                setNum('p50', pct.p50, 1, 'ms');
                setNum('p95', pct.p95, 1, 'ms');
                setNum('p99', pct.p99, 1, 'ms');

                updateChart('cpu', c.cpu);
                updateChart('mem', c.memory);
                updateChart('heap', c.heap);
                updateChart('load', c.loadAvg);
                updateChart('rt', c.responseTime);
                updateChart('rps', c.rps);
                updateChart('lag', c.eventLoopLag);
                updateChart('err', c.errorRate);

                renderRoutes('topRoutes', s.topRoutes, 'count', false);
                renderRoutes('slowRoutes', s.slowestRoutes, 'avgTime', true);
                renderRoutes('errRoutes', s.errorRoutes, 'errors', false);
                renderWorkers(s.workers);

                setText('s2xx', sumCodes(s.statusCodes, '2'));
                setText('s3xx', sumCodes(s.statusCodes, '3'));
                setText('s4xx', sumCodes(s.statusCodes, '4'));
                setText('s5xx', sumCodes(s.statusCodes, '5'));
                setText('rateLimited', s.rateLimitStats ? s.rateLimitStats.blocked : 0);

                renderErrors(s.recentErrors);
                applyAlertColors(s.alerts || {});
                renderHealth(data.health);

                setNum('heapTotal', s.heapTotalMB, 0);
                if (s.gc) setNum('heapGrowth', s.gc.heapGrowthRate, 2);

                setText('nodeVer', s.nodeVersion);
                setText('platform', String(s.platform).split(' ')[0]);
                setText('pid', s.pid);
                setText('cpuCount', s.cpuCount);
            }

            var INTERVAL = ${pollingInterval};
            var MAX_BACKOFF = 30000;
            var failures = 0, lastOk = 0, timer = null, inFlight = false;
            var basePath = window.location.pathname.endsWith('/') ? window.location.pathname : window.location.pathname + '/';

            // Chain polls with setTimeout: a slow response can't stack requests,
            // failures back off, and a hidden tab stops polling altogether.
            function schedule(delay) {
                clearTimeout(timer);
                if (document.hidden) return;
                timer = setTimeout(fetchMetrics, delay);
            }

            function fetchMetrics() {
                if (inFlight) return;
                inFlight = true;
                fetch(basePath + 'api/metrics', { cache: 'no-store', credentials: 'same-origin' })
                    .then(function(res) {
                        if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
                        return res.json();
                    })
                    .then(function(data) {
                        failures = 0;
                        lastOk = Date.now();
                        try { render(data); } catch (e) { console.error('Failed to render metrics:', e); }
                        setBadge('live', 'Live', 'Updated ' + new Date(lastOk).toLocaleTimeString());
                    })
                    .catch(function(err) {
                        failures++;
                        console.error('Failed to fetch metrics:', err);
                        var since = lastOk ? 'Last update ' + new Date(lastOk).toLocaleTimeString() : 'No data received yet';
                        if (err && (err.status === 401 || err.status === 403)) {
                            setBadge('down', 'Unauthorized', since);
                        } else if (lastOk) {
                            setBadge('stale', 'Stale · ' + Math.round((Date.now() - lastOk) / 1000) + 's', since);
                        } else {
                            setBadge('down', err && err.status ? 'Error ' + err.status : 'Offline', since);
                        }
                    })
                    .then(function() {
                        inFlight = false;
                        schedule(failures ? Math.min(INTERVAL * Math.pow(2, failures), MAX_BACKOFF) : INTERVAL);
                    });
            }

            document.addEventListener('visibilitychange', function() {
                if (!document.hidden) { clearTimeout(timer); fetchMetrics(); }
            });

            fetchMetrics();
        })();`;
}

/** One external script tag, with SRI when the URL is a pinned default. */
function scriptTag(url: string): string {
    const sri = DEFAULT_SRI[url];
    const integrity = sri ? ` integrity="${sri}" crossorigin="anonymous"` : '';
    return `<script src="${escapeHtml(url)}"${integrity}></script>`;
}

/** Chart.js + date adapter script tags, omitted when charts render inline. */
export function chartScriptTags(inlineCharts: boolean, chartjsUrl: string, chartAdapterUrl: string): string {
    return inlineCharts
        ? ''
        : `${scriptTag(chartjsUrl)}
    ${scriptTag(chartAdapterUrl)}`;
}

/** Opening tag for the inline client script, carrying the CSP nonce if any. */
export function inlineScriptOpen(nonce?: string): string {
    return nonce ? `<script nonce="${escapeHtml(nonce)}">` : '<script>';
}
