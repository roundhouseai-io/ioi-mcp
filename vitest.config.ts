import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    fileParallelism: false,
    poolOptions: { threads: { singleThread: true } },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
