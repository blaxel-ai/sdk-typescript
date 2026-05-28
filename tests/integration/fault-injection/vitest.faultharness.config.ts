import { defineConfig } from "vitest/config";

/**
 * Isolated config for the HTTP/2 fault-injection harness + regression corpus.
 *
 * Deliberately omits the root config's globalSetup (which lists live sandboxes
 * and needs BL_API_KEY) so these tests run with NO network and NO creds. The
 * same globs are also matched by the ROOT vitest config's `tests/**\/*.test.ts`
 * include, so CI picks them up; this config just lets us prove them green in
 * isolation.
 */
export default defineConfig({
  test: {
    include: [
      "tests/integration/fault-injection/**/*.test.ts",
      "tests/integration/regressions/**/*.test.ts",
    ],
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    reporters: ["verbose"],
  },
});
