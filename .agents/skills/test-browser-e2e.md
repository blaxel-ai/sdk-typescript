---
name: test-browser-e2e
description: Run an end-to-end browser test of the `@blaxel/core` SDK. Creates a real sandbox + preview session on the platform, bundles the browser build with esbuild, serves it locally, and drives it inside headless Chromium (via Playwright) to verify that filesystem.write/read and process.exec round-trip correctly against a live session. Use to validate that the browser stubs (`h2fetch`/`h2pool`/`h2warm`) and the `globalThis.fetch()` code path still work end-to-end. Trigger on "test browser e2e", "verify browser SDK", "browser sandbox test", or "/test-browser-e2e".
---

# Browser E2E Test for `@blaxel/core`

Validates that the browser build of `@blaxel/core` can actually drive a real sandbox from inside a real browser (headless Chromium), not just compile/load without error.

**What it proves:**

- `dist/esm-browser/` bundles without pulling `node:http2` / `net` / `tls` / `dns`.
- `SandboxInstance.fromSession({ url, token })` works under the `"browser"` export condition.
- `sbx.fs.write` (PUT), `sbx.fs.read` (GET), and `sbx.process.exec` (POST with SSE/NDJSON streaming + `onLog`) all round-trip correctly against a real preview session.

## Pre-requisites

1. **Logged into the Blaxel CLI** (`~/.blaxel/config.yaml` must have a valid workspace). Run `bl login` if needed. The harness defaults to `BL_WORKSPACE=main` — override on the command line for a different workspace.
2. **`@blaxel/core` built recently**: `cd @blaxel/core && npm run build`. The harness reads from `@blaxel/core/dist/esm-browser/index.js`.
3. **esbuild binary** available under `node_modules/.bun/esbuild@0.21.5/...`. If the path has changed, update `ESBUILD_BIN` in the harness (`find node_modules -name esbuild -path "*/.bin/*"` to locate).
4. **Playwright + a Chromium build**. The harness installs Playwright into `/tmp/pw-harness` if missing and reuses the existing browser cache in `~/Library/Caches/ms-playwright/chromium_headless_shell-*`. If the version mismatches, either:
   - Update `PLAYWRIGHT_CHROMIUM` in the harness to point at the installed build, or
   - Run `npx playwright install chromium-headless-shell` to fetch the version Playwright expects.

## Steps

### 1. Prepare Playwright + chromium

```bash
# One-off: install playwright into a scratch location so it resolves from anywhere
if [ ! -d /tmp/pw-harness/node_modules/playwright ]; then
  mkdir -p /tmp/pw-harness && cd /tmp/pw-harness
  npm init -y >/dev/null
  npm install playwright --prefer-offline --no-audit
fi

# Locate the latest chromium-headless-shell already cached locally
ls ~/Library/Caches/ms-playwright/ | grep chromium_headless_shell
```

If no matching build exists, run `npx playwright install chromium-headless-shell` once.

### 2. Free any stuck browser CLI server

Previous runs of the `browse` (gstack) CLI leave an orphan server on port 9400 that also steals 8765. Kill both if present:

```bash
lsof -ti :9400 -ti :8765 | xargs -I {} kill -9 {} 2>/dev/null || true
```

### 3. Write the harness

Create `tests/integration/.validate-browser-e2e.mjs` (git-ignored — the leading dot keeps it out of vitest globs) with the content below. Check `ESBUILD_BIN` and `PLAYWRIGHT_CHROMIUM` match your environment before running.

```js
// End-to-end browser validation harness.
// Node side: creates sandbox + preview session, bundles @blaxel/core for
// browser, serves an HTML page, drives it in headless Chromium.
import { SandboxInstance } from "@blaxel/core";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import http from "http";
import path from "path";
import fs from "fs";
import { chromium } from "/tmp/pw-harness/node_modules/playwright/index.mjs";

const ESBUILD_BIN = "/Users/cploujoux/projects/blaxel/sdk/sdk-typescript/node_modules/.bun/esbuild@0.21.5/node_modules/.bin/esbuild";
const PLAYWRIGHT_CHROMIUM = "/Users/cploujoux/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const CORE_ENTRY = "/Users/cploujoux/projects/blaxel/sdk/sdk-typescript/@blaxel/core/dist/esm-browser/index.js";

const name = `validate-browser-${Math.random().toString(36).slice(2, 8)}`;
const image = "blaxel/base-image:latest";
const workDir = "/tmp/validate-browser-e2e";
const port = 8765;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve(rootDir) {
  const server = http.createServer((req, res) => {
    const reqPath = new URL(req.url, "http://x").pathname;
    const filePath = path.join(rootDir, reqPath === "/" ? "index.html" : reqPath);
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      const body = fs.readFileSync(filePath);
      const ext = path.extname(filePath);
      const ct = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": ct });
      res.end(body);
    } catch {
      res.writeHead(404); res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

async function main() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  console.log(`[+] Creating sandbox ${name}`);
  const sandbox = await SandboxInstance.createIfNotExists({
    name,
    image,
    memory: 1024,
    labels: { env: "integration-test", "created-by": "validate-browser-e2e" },
  });
  try { await sandbox.wait({ maxWait: 120000, interval: 1000 }); } catch {}
  console.log(`[+] Sandbox ready`);

  const session = await sandbox.sessions.create({
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    responseHeaders: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Expose-Headers": "*",
    },
  });
  console.log(`[+] Session: ${session.name} @ ${session.url}`);

  const bundleOut = path.join(workDir, "bundle.js");
  const bundleRes = spawnSync(ESBUILD_BIN, [
    CORE_ENTRY, "--bundle", "--format=esm", "--platform=browser",
    "--conditions=browser,import", `--outfile=${bundleOut}`, "--log-level=warning",
  ], { encoding: "utf8" });
  if (bundleRes.status !== 0) throw new Error(`esbuild failed: ${bundleRes.stderr}`);

  const injected = {
    name: session.name,
    url: session.url,
    token: session.token,
    expiresAt: session.expiresAt instanceof Date ? session.expiresAt.toISOString() : session.expiresAt,
  };

  writeFileSync(path.join(workDir, "index.html"), `<!DOCTYPE html><html><body>
<pre id="out">loading…</pre>
<script type="module">
  import { SandboxInstance } from "./bundle.js";
  const out = document.getElementById("out");
  const log = (s) => { out.textContent += "\\n" + s; console.log(s); };
  const session = ${JSON.stringify(injected)};
  session.expiresAt = new Date(session.expiresAt);
  window.__RESULT = { status: "running" };
  try {
    const sbx = await SandboxInstance.fromSession(session);
    const p = "/tmp/browser-e2e-" + Date.now() + ".txt";
    const content = "hello from chromium " + Date.now();
    log("[1] fs.write"); await sbx.fs.write(p, content); log("    ok");
    log("[2] fs.read"); const readBack = await sbx.fs.read(p);
    if (readBack !== content) throw new Error("read mismatch: " + readBack);
    log("    read = " + JSON.stringify(readBack));
    log("[3] process.exec streaming");
    const logs = [];
    const res = await sbx.process.exec({
      name: "browser-exec-" + Date.now(),
      command: "sh -c 'echo from-browser-exec; echo done'",
      waitForCompletion: true,
      onLog: (l) => { logs.push(l); },
    });
    log("    status=" + res.status + " logs=" + JSON.stringify(logs));
    log("RESULT: PASS");
    window.__RESULT = { status: "pass", read: readBack, logs, execStatus: res.status };
  } catch (e) {
    log("RESULT: FAIL — " + (e?.message || e));
    window.__RESULT = { status: "fail", error: String(e?.message || e) };
  }
</script></body></html>`);

  const server = await serve(workDir);
  let result = null, browser = null;
  try {
    browser = await chromium.launch({ headless: true, executablePath: PLAYWRIGHT_CHROMIUM });
    const page = await (await browser.newContext()).newPage();
    const consoleMessages = [];
    page.on("console", (m) => consoleMessages.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => consoleMessages.push(`[pageerror] ${e.message}`));
    await page.goto(`http://localhost:${port}/index.html`, { waitUntil: "load" });
    for (let i = 0; i < 60; i++) {
      result = await page.evaluate(() => window.__RESULT);
      if (result && result.status !== "running") break;
      await sleep(1000);
    }
    console.log(`[+] Transcript:\n${await page.evaluate(() => document.getElementById("out").textContent)}`);
    console.log(`[+] __RESULT: ${JSON.stringify(result, null, 2)}`);
    if (consoleMessages.length) console.log(`[+] Console:\n  ${consoleMessages.join("\n  ")}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
    try { await SandboxInstance.delete(name); console.log(`[+] Sandbox deleted`); } catch (e) { console.log(`[!] delete failed: ${e?.message}`); }
  }

  if (!result || result.status !== "pass") { console.error(`[FAIL]`); process.exitCode = 2; }
  else console.log(`[PASS] browser bundle round-trips fs.write/read + process.exec against a real session`);
}

main().catch((e) => { console.error(`[ERR]`, e); process.exitCode = 1; });
```

### 4. Run it

```bash
cd @blaxel/core && npm run build && cd ../..
BL_WORKSPACE=main node tests/integration/.validate-browser-e2e.mjs
```

Expected tail on success:

```
[1] fs.write
    ok
[2] fs.read
    read = "hello from chromium <timestamp>"
[3] process.exec streaming
    status=completed logs=["from-browser-exec\ndone\n"]
RESULT: PASS
[+] Sandbox deleted
[PASS] browser bundle round-trips fs.write/read + process.exec against a real session
```

### 5. Clean up

```bash
rm tests/integration/.validate-browser-e2e.mjs
rm -rf /tmp/validate-browser-e2e
```

Leave `/tmp/pw-harness` around — the Playwright install is a sunk cost and the next run reuses it.

## Troubleshooting

- **`Executable doesn't exist at ...chromium_headless_shell-<N>`** — Playwright cache mismatch. Either update `PLAYWRIGHT_CHROMIUM` to the build you actually have (`ls ~/Library/Caches/ms-playwright/`), or run `npx playwright install chromium-headless-shell`.
- **`esbuild failed: ...` or `ENOENT` on esbuild** — update `ESBUILD_BIN` (`find node_modules -name esbuild -path "*/.bin/*" | head -1`).
- **`CORS` errors in the browser console** — the session was created without `responseHeaders` allowing `*`. The harness already injects them; re-check if you modified the `sessions.create(...)` call.
- **Harness hangs after `[+] Page loaded`** — the page threw before setting `window.__RESULT`. Check the `[+] Console:` dump printed at the end; `[pageerror]` lines point to the exact JS failure.
- **Sandbox is left behind** — the harness deletes it in a `finally` block, but if the Node process is killed hard you may need `bl sandbox delete validate-browser-*`.
