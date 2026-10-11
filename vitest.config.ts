import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/desktop/test/**/*.test.ts', 'tools/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
