import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'tests/e2e/**/*.test.ts',
    ],
    testTimeout: 300000, // 5 minutes
    hookTimeout: 120000, // 2 minutes
    globals: true,
    reporters: ['verbose'],
  },
})

