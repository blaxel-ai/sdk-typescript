import { defineConfig } from 'vitest/config'

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
    globalSetup: [],
    globalTeardown: ['tests/integration/sandbox/globalTeardown.ts', 'tests/benchmarks/sandbox/teardown.ts'],
    env: {
      // Tests will use environment variables from shell
      // BL_ENV: "dev"
    },
    benchmark: {
      include: ['tests/benchmarks/**/*.bench.ts'],
      reporters: ['default'],
    },
  },
})
