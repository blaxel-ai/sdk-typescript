/**
 * Manual end-to-end test for forking a sandbox into an Application.
 *
 * Flow:
 *   1. Create a source sandbox from the base image (blaxel/base-image, an Alpine
 *      image that ships Node) — no image build required.
 *   2. Write a tiny HTTP server into the sandbox, start it, and expose it through
 *      a public preview.
 *   3. Call the source preview over HTTP and assert it serves the app (proving
 *      the server is running before we fork).
 *   4. Fork the source sandbox into an Application via
 *      `source.fork(appName, { targetType: "application" })`. This produces a
 *      proxy application that rebinds to the (forked) sandbox — it inherits the
 *      source sandbox's image / memory / envs / port.
 *   5. Wait for the application to report DEPLOYED, then call its public run URL
 *      (`<runUrl>/<workspace>/applications/<appName>`) and assert it serves the
 *      app — the fork carried the running server across.
 *   6. Clean up every resource that was created (application + sandbox).
 *
 * This lives under tests/manual (not the automated suite) because it spins up a
 * real sandbox and forks it into a real application, which is far slower than
 * the 1-minute budget for integration tests.
 *
 * IMPORTANT: the app listens on port 3000, NOT 8080. Port 8080 is reserved by
 * the sandbox's own API server, so a preview pointed at 8080 returns the Blaxel
 * platform welcome page instead of your app.
 *
 * Requires: BL_WORKSPACE, BL_API_KEY
 *
 * Run:
 *   cd @blaxel/core && npm run build && cd ../..
 *   npx tsx tests/manual/fork-application.ts
 */

import { ApplicationInstance, SandboxInstance, settings } from "@blaxel/core"

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
const EXPECTED_BODY = "hello-from-blaxel-fork-app-test"

// A tiny HTTP server, written into the sandbox at runtime, that answers on APP_PORT.
const SERVER_JS =
  `const http = require("http");` +
  `http.createServer((req, res) => { res.writeHead(200); res.end("${EXPECTED_BODY}"); })` +
  `.listen(${APP_PORT}, () => console.log("listening on ${APP_PORT}"));`

const sourceName = uniqueName("fork-app-src")
const appName = uniqueName("fork-app-dst")
const createdSandboxes: string[] = []
const createdApplications: string[] = []

async function startServerAndPreview(
  sandbox: SandboxInstance,
  previewName: string,
): Promise<string> {
  // Write the server file and start it (without waiting for completion).
  await sandbox.fs.write(SERVER_PATH, SERVER_JS)
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

async function assertReachable(label: string, url: string): Promise<void> {
  console.log(`  ${label} URL: ${url}`)
  const response = await fetchWithRetry(url, undefined, { retries: 30, delayMs: 2000 })
  const body = await response.text()
  if (response.status !== 200 || body !== EXPECTED_BODY) {
    throw new Error(`${label} returned status=${response.status} body=${body}`)
  }
  console.log(`  ${label} is reachable and serving the app ✔`)
}

async function waitForApplicationDeployed(name: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const app = await ApplicationInstance.get(name)
    const status = app.status ?? "UNKNOWN"
    if (status === "DEPLOYED") {
      console.log(`  application ${name} is DEPLOYED`)
      return
    }
    if (status === "FAILED") {
      throw new Error(`application ${name} deployment FAILED`)
    }
    await sleep(2000)
  }
  throw new Error(`application ${name} did not reach DEPLOYED in time`)
}

// The default (no custom domain) public run URL of an application, matching the
// pattern the SDK uses for agents/functions: <runUrl>/<workspace>/applications/<name>.
function applicationUrl(name: string): string {
  return `${settings.runUrl}/${settings.workspace}/applications/${name}`
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

    // 2 + 3. Write + start server, expose preview, and call it (proves the
    // server is running before we fork it into an application).
    console.log("Starting server + preview on the source sandbox...")
    const sourceUrl = await startServerAndPreview(source, "src-preview")
    await assertReachable("source preview", sourceUrl)

    // 4. Fork the source sandbox into an application via the SandboxInstance helper.
    console.log(`Forking sandbox ${sourceName} -> application ${appName}`)
    const fork = await source.fork(appName, {
      targetType: "application",
      port: APP_PORT,
    })
    createdApplications.push(appName)
    console.log(`  forked into ${fork.type}: ${fork.name}`)
    if (fork.type !== "application") {
      throw new Error(`expected fork.type "application", got "${fork.type}"`)
    }

    // 5. Wait for the application to deploy, then call its public URL.
    console.log("Waiting for the application to deploy...")
    await waitForApplicationDeployed(appName)

    console.log("Calling the application's public URL...")
    await assertReachable("application", applicationUrl(appName))

    console.log(
      "\n✅ Fork-to-application flow succeeded: the application is callable at its URL.",
    )
  } finally {
    console.log("\n🧹 Cleaning up...")
    for (const name of createdApplications) {
      try {
        await ApplicationInstance.delete(name)
        console.log(`  deleted application ${name}`)
      } catch (e) {
        console.warn(`  failed to delete application ${name}: ${(e as Error).message}`)
      }
    }
    for (const name of createdSandboxes) {
      try {
        await SandboxInstance.delete(name)
        console.log(`  deleted sandbox ${name}`)
      } catch (e) {
        console.warn(`  failed to delete sandbox ${name}: ${(e as Error).message}`)
      }
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
