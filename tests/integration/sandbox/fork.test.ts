/**
 * Integration test for Sandbox Fork operations.
 *
 * Tests:
 * 1. Create a sandbox with a preview (running a server)
 * 2. Fork sandbox → sandbox (verify it works)
 * 3. Fork sandbox → application using the preview's port
 *    (the resulting application should be working/deployed)
 *
 * Requires: BL_WORKSPACE, BL_API_KEY, IMAGE_BUILD=true
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import {
  SandboxInstance,
  ApplicationInstance,
  ImageInstance,
  forkSandbox,
  createSandboxSnapshot,
  listSandboxSnapshots,
} from "@blaxel/core"
import { fetchWithRetry, isSlowTestEnabled, uniqueName, sleep, waitForSandboxDeployed } from './helpers.js'

/**
 * Wait for an application to reach DEPLOYED status.
 */
async function waitForApplicationDeployed(
  appName: string,
  maxAttempts = 90
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const app = await ApplicationInstance.get(appName)
      if (app.status === "DEPLOYED") return true
      if (app.status === "FAILED") {
        console.warn(`Application ${appName} entered FAILED status`)
        return false
      }
    } catch {
      // App may not exist yet during fork processing
    }
    await sleep(2000)
  }
  console.warn(`Timeout waiting for ${appName} to deploy`)
  return false
}

async function waitForSnapshotReady(
  sandboxName: string,
  snapshotId: string,
  maxAttempts = 60
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const { data } = await listSandboxSnapshots({
      path: { sandboxName },
      throwOnError: true,
    })
    const snapshot = data.find((item) => item.id === snapshotId)
    const status = snapshot?.status.toLowerCase()
    if (status === "ready") return true
    if (status === "failed") return false
    await sleep(2000)
  }
  return false
}

describe.runIf(isSlowTestEnabled("IMAGE_BUILD"))('Sandbox Fork Operations', () => {
  let sourceSandbox: SandboxInstance
  let previewUrl: string
  let snapshotId: string
  const sourceSandboxName = uniqueName("fork-src")
  const createdSandboxes: string[] = [sourceSandboxName]
  const createdApps: string[] = []

  beforeAll(async () => {
    // Build a sandbox with a simple HTTP server image
    const image = ImageInstance.fromRegistry("node:20-slim")
      .workdir("/app")
      .runCommands(
        "echo 'const http = require(\"http\"); const s = http.createServer((req, res) => { res.writeHead(200); res.end(\"hello-from-fork-source\"); }); s.listen(8080, () => console.log(\"listening on 8080\"));' > server.js"
      )
      .expose(8080)

    console.log(`Building source sandbox: ${sourceSandboxName}`)
    const sandbox = await image.build({
      name: sourceSandboxName,
      memory: 2048,
      timeout: 600000,
      onStatusChange: (status) => console.log(`  Build status: ${status}`),
      sandboxVersion: "latest",
    })

    expect(sandbox.status).toBe("DEPLOYED")
    sourceSandbox = await SandboxInstance.get(sourceSandboxName)

    // Start the HTTP server inside the sandbox
    console.log("Starting HTTP server on port 8080...")
    await sourceSandbox.process.exec({
      command: "node /app/server.js",
      waitForCompletion: false,
    })

    // Wait for the server to be ready
    await sleep(3000)

    // Verify server is running inside the sandbox
    const check = await sourceSandbox.process.exec({
      command: 'node -e "const http = require(\'http\'); http.get(\'http://localhost:8080\', res => { let d=\'\'; res.on(\'data\',c=>d+=c); res.on(\'end\',()=>console.log(d)); }).on(\'error\', e => { console.error(e.message); process.exit(1); })"',
      waitForCompletion: true,
    })
    expect(check.exitCode).toBe(0)
    expect(check.logs).toContain("hello-from-fork-source")

    // Create a preview on port 8080
    console.log("Creating preview on port 8080...")
    const preview = await sourceSandbox.previews.create({
      metadata: { name: "fork-preview" },
      spec: {
        port: 8080,
        public: true,
      },
    })

    expect(preview.spec.url).toBeDefined()
    previewUrl = preview.spec.url!
    console.log(`  Preview URL: ${previewUrl}`)

    // Verify the preview URL is reachable
    const response = await fetchWithRetry(previewUrl, undefined, { retries: 10, delayMs: 2000 })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toBe("hello-from-fork-source")
    console.log("  Preview is reachable and serving content")
  }, 900000) // 15 minute timeout for build + setup

  afterAll(async () => {
    // Clean up applications first
    for (const name of createdApps) {
      try {
        await ApplicationInstance.delete(name)
      } catch {
        // Ignore
      }
    }
    // Clean up sandboxes
    for (const name of createdSandboxes) {
      try {
        await SandboxInstance.delete(name)
      } catch {
        // Ignore
      }
    }
  })

  describe('snapshots', { timeout: 120000 }, () => {
    it('creates a snapshot of the source sandbox', async () => {
      const { data } = await createSandboxSnapshot({
        path: { sandboxName: sourceSandboxName },
        body: { name: "test-snapshot" },
        throwOnError: true,
      })

      expect(data).toBeDefined()
      expect(data.id).toBeDefined()
      expect(data.sandboxName).toBe(sourceSandboxName)
      snapshotId = data.id
      expect(await waitForSnapshotReady(sourceSandboxName, snapshotId)).toBe(true)
      console.log(`  Snapshot created: ${snapshotId}`)
    })

    it('lists snapshots for the source sandbox', async () => {
      const { data } = await listSandboxSnapshots({
        path: { sandboxName: sourceSandboxName },
        throwOnError: true,
      })

      expect(Array.isArray(data)).toBe(true)
      expect(data.length).toBeGreaterThan(0)

      const snapshot = data.find((item) => item.id === snapshotId)
      expect(snapshot?.sandboxName).toBe(sourceSandboxName)
      console.log(`  Found ${data.length} snapshot(s)`)
    })
  })

  describe('fork sandbox → sandbox', { timeout: 300000 }, () => {
    const targetSandboxName = uniqueName("fork-sbx-target")

    it('forks the source sandbox into a new sandbox', async () => {
      createdSandboxes.push(targetSandboxName)

      const { data } = await forkSandbox({
        path: { sandboxName: sourceSandboxName },
        body: {
          targetName: targetSandboxName,
          targetType: "sandbox",
          snapshotId,
        },
        throwOnError: true,
      })

      expect(data.type).toBe("sandbox")
      expect(data.name).toBe(targetSandboxName)
      expect(data.snapshotId).toBe(snapshotId)
      console.log(`  Forked to sandbox: ${data.name} (snapshot: ${data.snapshotId})`)
    })

    it('verifies the forked sandbox exists and deploys', async () => {
      const deployed = await waitForSandboxDeployed(targetSandboxName, 60)
      expect(deployed).toBe(true)

      const forked = await SandboxInstance.get(targetSandboxName)
      expect(forked.metadata.name).toBe(targetSandboxName)
      expect(forked.spec.runtime?.memory).toBe(2048)
      console.log(`  Forked sandbox deployed with memory: ${forked.spec.runtime?.memory}`)
    })
  })

  describe('fork sandbox → application', { timeout: 600000 }, () => {
    const targetAppName = uniqueName("fork-app-target")

    it('forks the source sandbox (with preview port) into an application', async () => {
      createdApps.push(targetAppName)

      const { data } = await forkSandbox({
        path: { sandboxName: sourceSandboxName },
        body: {
          targetName: targetAppName,
          targetType: "application",
          snapshotId,
          port: 8080,
        },
        throwOnError: true,
      })

      expect(data.type).toBe("application")
      expect(data.name).toBe(targetAppName)
      expect(data.snapshotId).toBe(snapshotId)
      console.log(`  Forked to application: ${data.name} (snapshot: ${data.snapshotId})`)
    })

    it('verifies the forked application exists and deploys', async () => {
      const deployed = await waitForApplicationDeployed(targetAppName)
      expect(deployed).toBe(true)

      const app = await ApplicationInstance.get(targetAppName)
      expect(app.name).toBe(targetAppName)
      expect(app.spec?.revisions).toBeDefined()
      expect(app.spec?.revisions?.length).toBeGreaterThan(0)

      // The forked app should have a snapshot reference
      const revision = app.spec?.revisions?.[0]
      expect(revision?.snapshot).toBe(snapshotId)

      expect(app.metadata.url).toBeDefined()
      const response = await fetchWithRetry(app.metadata.url!, undefined, { retries: 15, delayMs: 2000 })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("hello-from-fork-source")
      console.log(`  Application deployed and reachable at ${app.metadata.url}`)
    })
  })
})
