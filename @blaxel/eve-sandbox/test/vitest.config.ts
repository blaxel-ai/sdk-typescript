import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["@blaxel/eve-sandbox/test/**/*.test.ts"],
    hookTimeout: 59_000,
    testTimeout: 59_000,
  },
});
