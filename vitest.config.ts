import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            reporter: ['text-summary', 'json-summary', 'html'],
            thresholds: {
                lines: 80,
                statements: 80,
                functions: 80,
                branches: 70
            }
        }
    }
});
