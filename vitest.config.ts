import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/sandbox/integration/**/*.test.ts'],
    testTimeout: 300000, // 5 minutes - sandbox operations can be slow
    hookTimeout: 120000, // 2 minutes for setup/teardown
    globals: true,
    reporters: ['verbose'],
    env: {
      // Tests will use environment variables from shell
      // BL_ENV: "dev"
    },
    benchmark: {
      include: ['tests/sandbox/benchmarks/**/*.bench.ts'],
      reporters: ['default'],
    },
  },
})
