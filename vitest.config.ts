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
      // Egress proxy tests have been flaky for a while (proxy readiness, TLS,
      // preview 401 on non-routed egress); opt back in with RUN_PROXY_TESTS=true.
      ...(process.env.RUN_PROXY_TESTS === 'true' ? [] : ['tests/integration/sandbox/proxy/**']),
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
    // Central registry of every integration test gated behind an env var, so
    // the full list (and why each is gated) is discoverable in one place.
    // Override any of them per-run, e.g. `IMAGE_BUILD=true npx vitest run ...`.
    //
    // Two kinds of gate:
    //   * Feature toggles -- boolean opt-ins, default "false" (the test is too
    //     slow/heavy for the default run). Read via isSlowTestEnabled() or a
    //     `=== "true"` check.
    //   * Credential gates -- default "" so the test stays skipped until a real
    //     secret is supplied (in CI or locally). The pass-through keeps any
    //     value already present in the environment.
    env: {
      // Feature toggles (default off) -------------------------------------
      // schedules.test.ts > "firing": waits on the scheduler tick + a backend
      // cleanup pass (~45-65s), which can blow the 1-minute per-test budget.
      RUN_SLOW_SCHEDULES: process.env.RUN_SLOW_SCHEDULES ?? "false",
      // image-build.test.ts > "Image Build Integration": builds AND deploys a
      // custom image -- heavy and slow, needs the image-build pipeline.
      IMAGE_BUILD: process.env.IMAGE_BUILD ?? "false",
      // image.test.ts > "with custom Docker images": needs prebuilt custom
      // Docker images to be available/pullable in the target workspace.
      ENABLE_CUSTOM_DOCKER_TESTS: process.env.ENABLE_CUSTOM_DOCKER_TESTS ?? "false",

      // Credential gates (default "", i.e. skipped until provided) ---------
      // codegen.test.ts > "fastapply with Relace": third-party Relace API key.
      RELACE_API_KEY: process.env.RELACE_API_KEY ?? "",
      // codegen.test.ts > "fastapply with Morph": third-party Morph API key.
      MORPH_API_KEY: process.env.MORPH_API_KEY ?? "",
      // proxy/claude.test.ts > "proxy e2e with Claude Code agent": Anthropic
      // API key to drive a real Claude Code run through the egress proxy.
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
      // proxy/connect-tunnel.test.ts > "gcsfuse with native HTTP/2": a real GCS
      // bucket plus a service-account key to mount it over the tunnel.
      BL_TEST_GCS_BUCKET: process.env.BL_TEST_GCS_BUCKET ?? "",
      GCSFUSE_SA_KEY_JSON: process.env.GCSFUSE_SA_KEY_JSON ?? "",
    },
    benchmark: {
      include: ['tests/benchmarks/**/*.bench.ts'],
      reporters: ['default'],
      outputJson: './tmp/bench-results.json',
    },
  },
})
