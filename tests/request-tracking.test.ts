import { describe, it, expect, vi } from 'vitest';
import { createRequestTrackingMiddleware, isMonitorPath } from '../src/request-tracking';

function createMonitorStub() {
    return {
        config: { path: '/status' },
        trackRequest: vi.fn(),
        trackRequestComplete: vi.fn()
    };
}

describe('request tracking middleware', () => {
    it('should only skip the configured monitor path and its children', () => {
        expect(isMonitorPath('/status', '/status')).toBe(true);
        expect(isMonitorPath('/status/api/metrics', '/status')).toBe(true);
        expect(isMonitorPath('/statuscheck', '/status')).toBe(false);
    });

    it('should record failed requests as 500s and rethrow the error', async () => {
        const monitor = createMonitorStub();
        const middleware = createRequestTrackingMiddleware(monitor);
        const error = new Error('boom');

        await expect(middleware({
            req: { path: '/api/fails', method: 'GET' },
            res: undefined
        }, async () => {
            throw error;
        })).rejects.toThrow(error);

        expect(monitor.trackRequest).toHaveBeenCalledWith('/api/fails', 'GET');
        expect(monitor.trackRequestComplete).toHaveBeenCalledWith(
            '/api/fails',
            'GET',
            expect.any(Number),
            500
        );
    });

    it('should not track sibling routes that merely share the monitor path prefix', async () => {
        const monitor = createMonitorStub();
        const middleware = createRequestTrackingMiddleware(monitor);

        await middleware({
            req: { path: '/statuscheck', method: 'GET' },
            res: { status: 204 }
        }, async () => {});

        expect(monitor.trackRequest).toHaveBeenCalledWith('/statuscheck', 'GET');
        expect(monitor.trackRequestComplete).toHaveBeenCalledWith(
            '/statuscheck',
            'GET',
            expect.any(Number),
            204
        );
    });
});
