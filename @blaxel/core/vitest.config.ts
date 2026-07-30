import { defineConfig } from "vitest/config";

/**
 * Unit-test config for @blaxel/core, scoped to the package's own source tests.
 *
 * Without this, `npm test` here resolves to the repo-root vitest config whose
 * `include` is `tests/**` (integration/e2e) — so the package's `src/**` unit
 * tests never ran. This config runs them in isolation with NO globalSetup and
 * NO credentials. `*.integration.test.ts` files still require the real API and
 * are left to the root integration run.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "src/**/*.integration.test.ts",
    ],
    globals: true,
    testTimeout: 30000,
    reporters: ["verbose"],
  },
});
