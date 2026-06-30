import dotenv from 'dotenv'
import { defineConfig } from 'vitest/config'

dotenv.config()

export default defineConfig({
  test: {
    include: [
      'tests/**/*.test.ts',
    ],
    exclude: [
      'tests/e2e/**',
      'tests/load/**',
      'tests/runtime-environments/**',
      '**/node_modules/**',
      'tests/**/node_modules/**',
    ],
    testTimeout: 300000, // 5 minutes - API operations can be slow
    hookTimeout: 120000, // 2 minutes for setup/teardown
    globals: true,
    reporters: ['verbose'],
    fileParallelism: true,
    minWorkers: 1,
    maxWorkers: 10,
    sequence: {
      concurrent: false,
    },
    globalSetup: ['tests/integration/sandbox/globalTeardown.ts', 'tests/benchmarks/sandbox/teardown.ts'],
    // Central registry of opt-in slow integration tests. Each waits on real
    // backend timing and can exceed the 1-minute per-test budget, so it is off
    // by default here. Flip one to "true" to enable it, or override per-run
    // (e.g. RUN_SLOW_SCHEDULES=true npx vitest run ...). Read via
    // isSlowTestEnabled() from tests/integration/sandbox/helpers.ts.
    env: {
      RUN_SLOW_SCHEDULES: process.env.RUN_SLOW_SCHEDULES ?? "false",
    },
    benchmark: {
      include: ['tests/benchmarks/**/*.bench.ts'],
      reporters: ['default'],
      outputJson: './tmp/bench-results.json',
    },
  },
})
