import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // isolated-vm needs a host started with --no-node-snapshot (Node 20+); never --expose-gc.
    pool: 'forks',
    execArgv: ['--no-node-snapshot'],
    testTimeout: 30_000,
  },
});
