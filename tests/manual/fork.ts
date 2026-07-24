/**
 * Manual end-to-end test for the Sandbox fork feature.
 *
 * Flow:
 *   1. Build a source sandbox from a base image with a tiny HTTP server baked in.
 *   2. Start the server inside the sandbox and expose it through a public preview.
 *   3. Call the source preview over HTTP and assert it serves the app (not the
 *      sandbox platform page).
 *   4. Fork the source sandbox into a brand-new sandbox.
 *   5. Start the server on the fork and expose it through its own public preview.
 *   6. Call the fork preview over HTTP and assert it serves the app too.
 *   7. Clean up every resource that was created.
 *
 * This lives under tests/manual (not the automated suite) because it builds an
 * image and spins up two real sandboxes, which is far slower than the 1-minute
 * budget for integration tests.
 *
 * IMPORTANT: the app listens on port 3000, NOT 8080. Port 8080 is reserved by
 * the sandbox's own API server, so a preview pointed at 8080 returns the Blaxel
 * platform welcome page instead of your app.
 *
 * Requires: BL_WORKSPACE, BL_API_KEY
 *
 * Run:
 *   cd @blaxel/core && npm run build && cd ../..
 *   npx tsx tests/manual/fork.ts
 */

import {
  SandboxInstance,
  ImageInstance,
  forkSandbox,
} from "@blaxel/core"

// Self-contained helpers (this script runs under `tsx`, not vitest, so it must
// not import from the integration test helpers, which pull in vitest).
function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWithRetry(
  url: string,
  init: RequestInit | undefined,
  { retries, delayMs }: { retries: number; delayMs: number },
): Promise<Response> {
  let lastError: unknown
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, init)
      if (res.status < 500) return res
      lastError = new Error(`status ${res.status}`)
    } catch (e) {
      lastError = e
    }
    await sleep(delayMs)
  }
  throw new Error(`fetch ${url} failed after ${retries} retries: ${String(lastError)}`)
}

async function waitForSandboxDeployed(name: string, maxAttempts: number): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const sandbox = await SandboxInstance.get(name)
      if (sandbox.status === "DEPLOYED") return true
      if (sandbox.status === "FAILED") return false
    } catch {
      // not visible yet during fork processing
    }
    await sleep(2000)
  }
  return false
}

const APP_PORT = 3000
const EXPECTED_BODY = "hello-from-blaxel-fork-test"

// A tiny HTTP server, baked into the image, that answers on APP_PORT.
const SERVER_JS =
  `const http = require("http");` +
  `http.createServer((req, res) => { res.writeHead(200); res.end("${EXPECTED_BODY}"); })` +
  `.listen(${APP_PORT}, () => console.log("listening on ${APP_PORT}"));`

const sourceName = uniqueName("fork-src")
const forkName = uniqueName("fork-dst")
const createdSandboxes: string[] = []

async function startServerAndPreview(
  sandbox: SandboxInstance,
  previewName: string,
): Promise<string> {
  // Start the server (baked at /app/server.js) without waiting for completion.
  await sandbox.process.exec({
    command: `node /app/server.js`,
    waitForCompletion: false,
  })

  // Give the server a moment to bind the port.
  await sleep(3000)

  // Sanity check that the server answers from inside the sandbox.
  const check = (await sandbox.process.exec({
    command: `curl -s http://localhost:${APP_PORT}`,
    waitForCompletion: true,
  })) as { logs?: string }
  if (!check.logs?.includes(EXPECTED_BODY)) {
    throw new Error(
      `Server not reachable inside ${sandbox.metadata.name}; got: ${check.logs}`,
    )
  }

  // Expose it through a public preview.
  const preview = await sandbox.previews.create({
    metadata: { name: previewName },
    spec: { port: APP_PORT, public: true },
  })
  const url = preview.spec?.url
  if (!url) throw new Error(`Preview ${previewName} has no URL`)
  return url
}

async function assertPreviewReachable(label: string, url: string): Promise<void> {
  console.log(`  ${label} preview URL: ${url}`)
  const response = await fetchWithRetry(url, undefined, { retries: 15, delayMs: 2000 })
  const body = await response.text()
  if (response.status !== 200 || body !== EXPECTED_BODY) {
    throw new Error(
      `${label} preview returned status=${response.status} body=${body}`,
    )
  }
  console.log(`  ${label} preview is reachable and serving the app ✔`)
}

async function main() {
  try {
    // 1. Build the source sandbox from a base image with the server baked in.
    console.log(`Building source sandbox: ${sourceName}`)
    // base64-encode the payload so the server source is decoupled from shell
    // quoting (no risk of quotes/`$`/backticks in the JS breaking the command).
    const serverB64 = Buffer.from(SERVER_JS, "utf8").toString("base64")
    const image = ImageInstance.fromRegistry("node:20-slim")
      .workdir("/app")
      .runCommands(`echo ${serverB64} | base64 -d > /app/server.js`)
      .expose(APP_PORT)

    const built = await image.build({
      name: sourceName,
      memory: 2048,
      timeout: 600000,
      onStatusChange: (status) => console.log(`  build status: ${status}`),
      sandboxVersion: "latest",
    })
    createdSandboxes.push(sourceName)
    if (built.status !== "DEPLOYED") {
      throw new Error(`Source sandbox failed to deploy: ${built.status}`)
    }

    const source = await SandboxInstance.get(sourceName)

    // 2 + 3. Start server, expose preview, and call it.
    console.log("Starting server + preview on the source sandbox...")
    const sourceUrl = await startServerAndPreview(source, "src-preview")
    await assertPreviewReachable("source", sourceUrl)

    // 4. Fork the source sandbox into a new sandbox.
    console.log(`Forking ${sourceName} -> ${forkName}`)
    const { data: fork } = await forkSandbox({
      path: { sandboxName: sourceName },
      body: { targetName: forkName, targetType: "sandbox" },
      throwOnError: true,
    })
    createdSandboxes.push(forkName)
    console.log(`  forked into ${fork?.type}: ${fork?.name}`)

    const deployed = await waitForSandboxDeployed(forkName, 90)
    if (!deployed) throw new Error(`Forked sandbox ${forkName} did not deploy`)
    const forked = await SandboxInstance.get(forkName)

    // 5 + 6. Start server, expose a preview on the fork, and call it.
    console.log("Starting server + preview on the forked sandbox...")
    const forkUrl = await startServerAndPreview(forked, "fork-preview")
    await assertPreviewReachable("fork", forkUrl)

    console.log("\n✅ Fork end-to-end flow succeeded: both previews are callable.")
  } finally {
    console.log("\n🧹 Cleaning up...")
    for (const name of createdSandboxes) {
      try {
        await SandboxInstance.delete(name)
        console.log(`  deleted sandbox ${name}`)
      } catch (e) {
        console.warn(`  failed to delete ${name}: ${(e as Error).message}`)
      }
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
