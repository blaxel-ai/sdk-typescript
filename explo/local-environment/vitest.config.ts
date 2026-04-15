import dotenv from "dotenv"
import { defineConfig } from "vitest/config"

dotenv.config()

export default defineConfig({
  test: {
    include: ["explo/local-environment/**/*.test.ts"],
    testTimeout: 300000,
    hookTimeout: 120000,
    globals: true,
    reporters: ["verbose"],
  },
})
