// =============================================================================
// HONO STATUS MONITOR - EDGE STATUS FACTORY
// Edge-compatible entry point. Route/handle assembly lives in status-factory.
// =============================================================================

import type { StatusMonitorConfig } from './types.js';
import { createEdgeMonitor } from './monitor-edge.js';
import { assembleStatusMonitor } from './status-factory.js';

export function createEdgeStatusMonitor(config: StatusMonitorConfig = {}) {
    const monitor = createEdgeMonitor(config);

    return assembleStatusMonitor(monitor, {
        // Lazily loaded so the dashboard markup can be split out of the entry
        // chunk by bundlers that support code splitting.
        renderDashboard: async (m, snapshot, { nonce }) => {
            const { generateEdgeDashboard } = await import('./dashboard-edge.js');
            return generateEdgeDashboard({
                hostname: snapshot.hostname,
                platformLabel: snapshot.platform,
                nonce,
                uptime: m.formatUptime(snapshot.uptime),
                title: m.config.title,
                pollingInterval: m.config.pollingInterval,
                chartjsUrl: m.config.chartjsUrl,
                chartAdapterUrl: m.config.chartAdapterUrl,
                inlineCharts: m.config.inlineCharts
            });
        },
        // No SSE stream on edge isolates.
        enableStream: false,
        isEdgeMode: true,
        initSocket: (): null => null
    });
}
