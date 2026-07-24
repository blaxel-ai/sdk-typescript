/**
 * Manual end-to-end test for the Sandbox fork feature.
 *
 * Flow:
 *   1. Create a source sandbox from the base image (blaxel/base-image, an Alpine
 *      image that ships Node) — no image build required.
 *   2. Write a tiny HTTP server into the sandbox, start it, and expose it through
 *      a public preview.
 *   3. Call the source preview over HTTP and assert it serves the app (not the
 *      sandbox platform page).
 *   4. Fork the source sandbox into a brand-new sandbox.
 *   5. Write + start the server on the fork and expose it through its own public
 *      preview (process/filesystem state is not assumed to survive the fork).
 *   6. Call both previews over HTTP and assert each serves the app.
 *   7. Clean up every resource that was created.
 *
 * This lives under tests/manual (not the automated suite) because it spins up
 * two real sandboxes and forks between them, which is far slower than the
 * 1-minute budget for integration tests.
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

import { SandboxInstance } from "@blaxel/core"

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

const BASE_IMAGE = "blaxel/base-image:latest"
const APP_PORT = 3000
const SERVER_PATH = "/app/server.js"
const EXPECTED_BODY = "hello-from-blaxel-fork-test"

// A tiny HTTP server, written into the sandbox at runtime, that answers on APP_PORT.
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
  // Write the server file (fork does not guarantee filesystem/process state, so
  // we (re)write and start it explicitly on every sandbox).
  await sandbox.fs.write(SERVER_PATH, SERVER_JS)

  // Start the server without waiting for completion.
  await sandbox.process.exec({
    command: `node ${SERVER_PATH}`,
    waitForCompletion: false,
  })

  // Give the server a moment to bind the port.
  await sleep(3000)

  // Sanity check that the server answers from inside the sandbox. The base
  // image ships Node but not curl.
  const check = (await sandbox.process.exec({
    command: `node -e 'require("http").get("http://localhost:${APP_PORT}", (res) => { let body = ""; res.on("data", (chunk) => body += chunk); res.on("end", () => { process.stdout.write(body); process.exit(res.statusCode === 200 && body === "${EXPECTED_BODY}" ? 0 : 1); }); }).on("error", () => process.exit(1))'`,
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
    // 1. Create the source sandbox from the base image (no image build).
    console.log(`Creating source sandbox: ${sourceName}`)
    const source = await SandboxInstance.create({
      name: sourceName,
      image: BASE_IMAGE,
      memory: 2048,
      ports: [{ target: APP_PORT, protocol: "HTTP" }],
    })
    createdSandboxes.push(sourceName)

    // 2 + 3. Write + start server, expose preview, and call it.
    console.log("Starting server + preview on the source sandbox...")
    const sourceUrl = await startServerAndPreview(source, "src-preview")
    await assertPreviewReachable("source", sourceUrl)

    // 4. Fork the source sandbox into a new sandbox via the SandboxInstance helper.
    console.log(`Forking ${sourceName} -> ${forkName}`)
    const fork = await source.fork(forkName, { targetType: "sandbox" })
    createdSandboxes.push(forkName)
    console.log(`  forked into ${fork.type}: ${fork.name}`)

    const forked = await SandboxInstance.get(forkName)

    // 5 + 6. Write + start server, expose a preview on the fork, and call it.
    console.log("Starting server + preview on the forked sandbox...")
    const forkUrl = await startServerAndPreview(forked, "fork-preview")
    await assertPreviewReachable("fork", forkUrl)
    await assertPreviewReachable("source after fork", sourceUrl)

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
