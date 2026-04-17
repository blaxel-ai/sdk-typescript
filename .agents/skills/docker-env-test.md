---
name: docker-env-test
description: Test every SDK onboarding path inside a Docker container with a clean environment (no ~/.blaxel/config.yaml, no leaked env vars). Covers all authentication methods, environment resolution, and lazy init. Uses Playwright to acquire credentials if not cached. Trigger on "docker env test", "clean env test", "test onboarding", "test empty environment", or "/docker-env-test".
---

# SDK Onboarding Tests (Docker)

Test every way a user can start using the Blaxel TypeScript SDK, in a Docker container with zero local state.

## Why Docker

The host machine has `~/.blaxel/config.yaml`, env vars, and cached node_modules that mask real onboarding bugs. Docker guarantees a clean slate: no config files, no env vars, no prior auth state.

---

## Phase 0: Acquire credentials

Tests need real credentials. Before creating anything, check the **credential cache** at `~/.claude/secrets/test-credentials.json` in the repo root.

### Cache file format

```json
{
  "workspace": "main",
  "apiKey": "bl_...",
  "saClientId": "uuid",
  "saClientSecret": "secret",
  "createdAt": "2026-04-16T12:00:00Z"
}
```

### Decision flow

1. Read `~/.claude/secrets/test-credentials.json`. If it exists:
   - Try a quick validation: `initialize({ workspace, apiKey })` then `listWorkspaces()`.
   - If it succeeds: credentials are still valid. Skip to Phase 1.
   - If it fails (401/403): credentials expired. Delete the cache and continue below.
2. If no cache or cache is invalid, acquire fresh credentials.

### Acquiring credentials via Playwright

Use the `/browse` skill (`$B` binary) to log into the Blaxel console, create an API key and a service account.

**Important**: before browsing, run `/import-blaxel-cookies` or `/setup-browser-cookies` to import existing browser sessions. This avoids manual login.

#### Step A: Get or create an API key

```bash
$B goto https://app.blaxel.ai/<workspace>/settings/api-keys
$B snapshot -i
```

- If an existing API key is visible, copy its value (or note that API keys are only shown at creation).
- Otherwise, click "Create API key", fill the form, and capture the key from the response.
- Save the key.

**Alternative (faster, if host has config.yaml auth):** use the SDK on the host:

```javascript
// setup-credentials.mjs
const { settings } = await import("../../@blaxel/core/dist/esm/index.js");
const { listWorkspaces, createWorkspaceServiceAccount, createApiKeyForServiceAccount }
  = await import("../../@blaxel/core/dist/esm/client/sdk.gen.js");

await listWorkspaces({ throwOnError: true }); // warm up auth

const workspace = settings.workspace;
const apiKey = settings.token; // current valid JWT, usable as Bearer token
```

#### Step B: Create a service account (for client-credentials tests)

```bash
$B goto https://app.blaxel.ai/<workspace>/settings/service-accounts
$B snapshot -i
$B click <create-button>
$B fill <name-field> "sdk-onboarding-test"
$B click <submit>
$B snapshot -i   # capture client_id and client_secret from the response
```

**Alternative (faster):**

```javascript
const sa = await createWorkspaceServiceAccount({
  body: { name: "sdk-onboarding-test-" + Date.now(), description: "Auto-created for Docker onboarding tests" },
  throwOnError: true,
});
// sa.data.client_id, sa.data.client_secret
```

#### Step C: Save to cache

Write `~/.claude/secrets/test-credentials.json` with all acquired values. This file is gitignored (it contains secrets). Add it to `.gitignore` if not already present.

```javascript
import fs from "fs";
fs.writeFileSync("~/.claude/secrets/test-credentials.json", JSON.stringify({
  workspace,
  apiKey,
  saClientId: sa.data.client_id,
  saClientSecret: sa.data.client_secret,
  createdAt: new Date().toISOString(),
}, null, 2));
```

From now on, subsequent runs of `/docker-env-test` skip the Playwright/SDK setup entirely and go straight to Phase 1.

---

## Phase 1: Build the SDK

```bash
cd @blaxel/core && npm run build
```

---

## Phase 2: Write the test files

Create `tests/sanity/docker-tests.mjs` and `tests/sanity/Dockerfile`.

### Dockerfile

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY @blaxel/core/package.json @blaxel/core/package.json
COPY @blaxel/core/dist @blaxel/core/dist
RUN cd @blaxel/core && npm install --omit=dev 2>&1 | tail -5
COPY tests/sanity/docker-tests.mjs tests/sanity/docker-tests.mjs
RUN rm -rf /root/.blaxel
CMD ["node", "tests/sanity/docker-tests.mjs"]
```

Notes:
- This repo uses bun. There is no `package-lock.json`. The Dockerfile runs `npm install` inside the container from `package.json` alone.
- Add `--platform linux/arm64` on Apple Silicon.

### Test script

`tests/sanity/docker-tests.mjs` receives env vars: `TEST_WORKSPACE`, `TEST_API_KEY`, `TEST_SA_CLIENT_ID`, `TEST_SA_SECRET`.

Imports use relative paths: `../../@blaxel/core/dist/esm/index.js` (relative to the script, not the CWD).

Each test section resets state via `initialize({})` and clears env vars before starting. Use a `pass(name, detail)` / `fail(name, detail)` helper that collects results and prints a summary at the end (exit 0 if all pass, 1 otherwise).

---

## Phase 3: Onboarding scenarios

### Test 1: Zero-config import

A user who just `npm install @blaxel/core` and imports it. No credentials anywhere.

```javascript
delete process.env.BL_ENV;
delete process.env.BL_WORKSPACE;
delete process.env.BL_API_KEY;
const { settings } = await import(SDK);
```

**Assert:**
- `process.env.BL_ENV === undefined` (no side-effects on import)
- `settings.baseUrl === "https://api.blaxel.ai/v0"` (defaults to prod)
- No crash, no file-not-found error

### Test 2: API key via `initialize()`

```javascript
initialize({ workspace: TEST_WORKSPACE, apiKey: TEST_API_KEY });
// Do NOT call authenticate()
const result = await listWorkspaces();
```

**Assert:**
- `result.data` is an array (auth worked lazily via interceptor)

### Test 3: API key via env vars

```javascript
process.env.BL_API_KEY = TEST_API_KEY;
process.env.BL_WORKSPACE = TEST_WORKSPACE;
// Reset SDK credentials so it re-reads from env
settings.credentials = null;
const result = await listWorkspaces();
```

**Assert:**
- `result.data` is an array
- `settings.workspace === TEST_WORKSPACE`

### Test 4: Client credentials via `initialize()`

```javascript
initialize({
  workspace: TEST_WORKSPACE,
  clientCredentials: { clientId: TEST_SA_CLIENT_ID, clientSecret: TEST_SA_SECRET },
});
const r1 = await listWorkspaces(); // triggers lazy OAuth token fetch
const r2 = await listWorkspaces(); // reuses cached token
```

**Assert:**
- Both `r1.data` and `r2.data` are arrays (even if 0 results for the SA)
- No duplicate token fetch on second call

### Test 5: Client credentials via env var

```javascript
process.env.BL_CLIENT_CREDENTIALS = btoa(`${TEST_SA_CLIENT_ID}:${TEST_SA_SECRET}`);
process.env.BL_WORKSPACE = TEST_WORKSPACE;
settings.credentials = null;
const result = await listWorkspaces();
```

**Assert:**
- `result.data` is an array

### Test 6: Config file auth (DeviceMode)

Mount a synthetic `~/.blaxel/config.yaml` at runtime inside the container. Write a minimal YAML with a workspace that has `env: dev` and device_code + refresh_token + access_token.

**Note:** this test may be skipped if device-mode credentials are not available in the cache. It is mainly relevant when testing the config.yaml parsing path and `BL_ENV` resolution.

**Assert:**
- `process.env.BL_ENV` is NOT set after import
- `process.env.BL_ENV === "dev"` after first SDK call (ensureAutoloaded sets it)

### Test 7: Environment resolution

```javascript
process.env.BL_ENV = "dev";
// ASSERT: settings.baseUrl === "https://api.blaxel.dev/v0"
// ASSERT: settings.runUrl === "https://run.blaxel.dev"

process.env.BL_API_URL = "https://custom.api/v0";
// ASSERT: settings.baseUrl === "https://custom.api/v0"

process.env.BL_RUN_URL = "https://custom.run";
// ASSERT: settings.runUrl === "https://custom.run"
```

These are pure unit checks, no network calls needed.

### Test 8: Sentry deferred init

```javascript
const { isSentryInitialized } = await import(SENTRY_PATH);
// ASSERT: isSentryInitialized() === false after import
// (In dev builds the DSN placeholder is empty, so initSentry correctly no-ops
// even after ensureAutoloaded runs. The key assertion is that it was NOT
// called at import time.)
```

### Test 9: Framework integration imports (optional)

If framework packages are built and available:

```javascript
await import("../../@blaxel/langgraph/dist/esm/index.js");
await import("../../@blaxel/vercel/dist/esm/index.js");
// ASSERT: no crash, no side-effects on process.env
```

Skip if packages are not built.

---

## Phase 4: Build and run Docker

```bash
docker build -f tests/sanity/Dockerfile -t blaxel-sdk-sanity .

# Read cached credentials
CREDS="~/.claude/secrets/test-credentials.json"
WORKSPACE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CREDS','utf8')).workspace)")
API_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CREDS','utf8')).apiKey)")
SA_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CREDS','utf8')).saClientId)")
SA_SECRET=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CREDS','utf8')).saClientSecret)")

docker run --rm \
  -e TEST_WORKSPACE="$WORKSPACE" \
  -e TEST_API_KEY="$API_KEY" \
  -e TEST_SA_CLIENT_ID="$SA_ID" \
  -e TEST_SA_SECRET="$SA_SECRET" \
  blaxel-sdk-sanity
```

---

## Phase 5: Cleanup

Remove temp files and Docker image. Do NOT delete `~/.claude/secrets/test-credentials.json` (it is the persistent cache for next run).

```bash
rm -rf tests/sanity
docker rmi blaxel-sdk-sanity 2>/dev/null
```

To delete the service account (only when explicitly asked or when credentials are rotated):

```javascript
await deleteWorkspaceServiceAccount({ path: { clientId: saClientId }, throwOnError: true });
rm ~/.claude/secrets/test-credentials.json
```

---

## Expected output

```
========== Test 1: Zero-config import ==========
  PASS: No side-effects on import
  PASS: baseUrl defaults to prod

========== Test 2: API key via initialize() ==========
  PASS: listWorkspaces returned N workspaces

========== Test 3: API key via env vars ==========
  PASS: listWorkspaces returned N workspaces

========== Test 4: Client credentials via initialize() ==========
  PASS: First call OK (token fetched lazily)
  PASS: Second call OK (token reused)

========== Test 5: Client credentials via env var ==========
  PASS: listWorkspaces returned N workspaces

========== Test 6: Config file auth ==========
  PASS: BL_ENV not set on import, set to "dev" after SDK call

========== Test 7: Environment resolution ==========
  PASS: BL_ENV=dev -> api.blaxel.dev
  PASS: BL_API_URL overrides baseUrl
  PASS: BL_RUN_URL overrides runUrl

========== Test 8: Sentry deferred ==========
  PASS: Not initialized at import

========== SUMMARY ==========
All tests passed.
```

## Troubleshooting

- **Cached credentials expired (401)**: the cache is auto-invalidated. Re-run the skill, it will re-acquire via Playwright or SDK.
- **No host auth for SDK setup**: use `bl login` or the Playwright path with `/import-blaxel-cookies`.
- **SA returns 0 workspaces**: normal, service accounts have limited scope. The test checks for a successful response, not a specific count.
- **Platform mismatch on macOS**: use `--platform linux/arm64` in `docker build`.
- **No `package-lock.json`**: expected, repo uses bun.
- **Module not found in Docker**: imports must be relative to the test script (`../../@blaxel/core/dist/esm/...`), not the CWD.
