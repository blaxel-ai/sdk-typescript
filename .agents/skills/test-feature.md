---
name: test-feature
description: Build the SDK and run integration tests for a feature. Covers the full cycle from build to writing tests to executing them. Trigger on "test feature", "run integration tests", "test this change", or "/test-feature".
---

# Test a Feature

Build the SDK and run integration tests to validate a change end-to-end against the Blaxel platform.

## Prerequisites check

Before running any integration test, verify that credentials are set:

```bash
echo "BL_WORKSPACE=${BL_WORKSPACE:-NOT SET}"
echo "BL_API_KEY=${BL_API_KEY:-NOT SET}"
```

**If either is missing, stop and tell the user.** They need to set both:
```bash
export BL_WORKSPACE=<workspace>
export BL_API_KEY=<api-key>
```

Or have them in a `.env` file at the repo root (vitest loads it via `dotenv`).

Do NOT attempt to run integration tests without these variables -- they will fail with auth errors.

## Step 1: Build

Always rebuild `@blaxel/core` before running integration tests. Tests import from the compiled `dist/` output, not from source.

```bash
cd @blaxel/core && npm run build
```

If the build fails, fix the errors first. Common issues:
- Type conflicts after SDK regeneration (see `/regenerate-sdk` skill)
- Missing exports in `src/sandbox/index.ts` or `src/index.ts`

## Step 2: Write the integration test

Tests live in `tests/integration/sandbox/`. Follow the existing patterns:

### File structure
```typescript
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { SandboxInstance } from "@blaxel/core"
import { uniqueName, defaultImage, defaultLabels } from './helpers.js'

describe('Feature Name', () => {
  let sandbox: SandboxInstance
  const sandboxName = uniqueName("feature-test")

  beforeAll(async () => {
    sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: defaultImage,
      memory: 2048,
      labels: defaultLabels,
    })
  })

  afterAll(async () => {
    try { await SandboxInstance.delete(sandboxName) } catch {}
  })

  it('does something', async () => {
    // test code
  })
})
```

### Key conventions
- Use `uniqueName("prefix")` to avoid sandbox name collisions across parallel runs.
- Always add `labels: defaultLabels` so the global teardown can clean up leaked resources.
- Use `afterAll` to delete sandboxes even if tests fail.
- Test timeouts are 5 minutes (`testTimeout: 300000` in vitest config). Individual tests can override: `it('name', { timeout: 120000 }, async () => { ... })`.

### Available helpers (`tests/integration/sandbox/helpers.ts`)
- `uniqueName(prefix)` -- generate unique sandbox name
- `defaultImage` -- `"blaxel/base-image:latest"`
- `defaultLabels` -- `{ env: "integration-test", language: "typescript", "created-by": "vitest-integration" }`
- `defaultRegion` -- `"us-was-1"` (prod) or `"eu-dub-1"` (dev, when `BL_ENV=dev`)
- `sleep(ms)` -- promise-based delay
- `waitForSandboxDeployed(name)` -- poll until sandbox is DEPLOYED
- `waitForSandboxDeletion(name)` -- poll until sandbox is fully gone
- `fetchWithRetry(url, options)` -- fetch with retries on 401/5xx
- `retry(fn, options)` -- generic retry wrapper

## Step 3: Run the tests

### Run a single test file
```bash
npx vitest run tests/integration/sandbox/<file>.test.ts --reporter=verbose
```

### Run all integration tests
```bash
npx vitest run --reporter=verbose
```

### Run tests matching a pattern
```bash
npx vitest run -t "Drive Operations" --reporter=verbose
```

### Existing test files by area

| Area | Test file | What it covers |
|------|-----------|---------------|
| Sandbox CRUD | `sandbox-crud.test.ts` | create, get, list, delete, createIfNotExists, updateMetadata |
| Process | `process.test.ts` | exec, logs, streamLogs, wait, kill, restartOnFailure |
| Filesystem | `filesystem.test.ts` | write, read, binary, mkdir, ls, rm, search, find, grep, watch |
| Previews | `previews.test.ts` | create, list, get, delete, tokens, CORS headers |
| Sessions | `sessions.test.ts` | create, list, delete, fromSession |
| Drives | `drives.test.ts` | DriveInstance CRUD, mount, unmount, list, persistence |
| Volumes | `volumes.test.ts` | VolumeInstance CRUD, attach to sandbox |
| Lifecycle | `lifecycle.test.ts` | TTL, expiration policies |
| Interpreter | `interpreter.test.ts` | CodeInterpreter.runCode, createCodeContext |
| Codegen | `codegen.test.ts` | fastapply, reranking |
| Images | `image.test.ts`, `image-build.test.ts` | custom image builds |
| System | `system.test.ts` | upgrade |
| Regions | `region.test.ts` | multi-region sandbox creation |
| Network | `proxy.test.ts` | port proxying, fetch |

## Step 4: Interpret results

- **All green**: the feature works end-to-end.
- **Auth errors (401)**: `BL_WORKSPACE` or `BL_API_KEY` is wrong or missing.
- **Timeout errors**: sandbox operations can be slow. Increase timeout if needed, but investigate if a test consistently takes >2 minutes.
- **404 on sandbox API calls**: the SDK client may be out of sync with the deployed sandbox-api. Check if a SDK regeneration is needed (see `/regenerate-sdk`).
- **Global teardown**: after all tests finish, `globalTeardown.ts` automatically cleans up sandboxes and volumes with the `integration-test` label.

## Quick reference

```bash
# Full cycle: build + run one test file
cd @blaxel/core && npm run build && cd ../.. && npx vitest run tests/integration/sandbox/drives.test.ts --reporter=verbose

# Full cycle: build + run all
cd @blaxel/core && npm run build && cd ../.. && npx vitest run --reporter=verbose
```
