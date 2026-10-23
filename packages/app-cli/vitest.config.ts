import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Several tests bundle apps with esbuild and spawn Node; keep them in one worker at a time.
    fileParallelism: false,
  },
});
