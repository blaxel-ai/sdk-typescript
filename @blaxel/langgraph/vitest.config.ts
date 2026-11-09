import { defineConfig } from "vitest/config";

// Unit tests only; the repo-root config targets tests/** (integration).
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], reporters: ["verbose"] },
});
