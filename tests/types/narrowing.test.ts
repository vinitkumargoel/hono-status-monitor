// Compile-time checks: `isEdgeMode` narrows the handle returned by the main entry.
import { describe, it, expect } from 'vitest';
import { statusMonitor } from '../../src/index';

describe('handle types', () => {
    it('narrows monitor.monitor through isEdgeMode', () => {
        const handle = statusMonitor({ publicAccess: true, logger: false });
        if (handle.isEdgeMode) {
            // afterRequest exists only on the edge monitor; this compiles only when narrowed.
            expect(typeof handle.monitor.afterRequest).toBe('function');
        } else {
            // afterRequest exists only on the edge monitor.
            // @ts-expect-error — narrowed to the Node monitor
            handle.monitor.afterRequest;
            expect(typeof handle.monitor.start).toBe('function');
        }
    });
});
