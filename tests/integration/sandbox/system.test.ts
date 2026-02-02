import { SandboxInstance, settings } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultLabels, defaultRegion, sleep, uniqueName } from './helpers.js'
import { HealthResponse } from "@blaxel/core/sandbox/client/types.gen.js"

const VERSION = process.env.BL_ENV === "dev" ? "develop" : "latest"

/**
 * Wait for sandbox upgrade to complete by polling the health endpoint
 * Returns the health data when upgrade count > 0, throws if upgrade failed
 */
async function waitForUpgradeComplete(
  sandboxHost: string,
  maxWaitTime: number = 30000
): Promise<HealthResponse> {
  console.log(`[TEST] Waiting for health upgrade count > 0...`)
  const healthCheckStartTime = Date.now()
  let healthData: HealthResponse | null = null

  while (Date.now() - healthCheckStartTime < maxWaitTime) {
    try {
      const healthResponse = await fetch(`${sandboxHost}/health`, {
        method: "GET",
        headers: settings.headers,
      })
      healthData = await healthResponse.json() as HealthResponse
      console.log(`[TEST] Health check - upgradeCount: ${healthData.upgradeCount} (elapsed: ${Date.now() - healthCheckStartTime}ms)`)
      if (healthData.upgradeCount && healthData.upgradeCount > 0) {
        console.log(`[TEST] Upgrade completed (took ${Date.now() - healthCheckStartTime}ms)`)
        return healthData
      }
      if (healthData?.lastUpgrade?.status === "failed") {
        console.log(`[TEST] Health check - last upgrade failed, health data:`, healthData)
        throw new Error(`Upgrade failed: ${JSON.stringify(healthData)}`)
      }
    } catch (error: unknown) {
      // Re-throw upgrade failures
      if (error instanceof Error && error.message.startsWith("Upgrade failed:")) {
        throw error
      }
      console.log(`[TEST] Health check error: ${String(error)} (elapsed: ${Date.now() - healthCheckStartTime}ms)`)
    }
    await sleep(500)
  }

  throw new Error(`Upgrade did not complete within ${maxWaitTime}ms. Last health data: ${JSON.stringify(healthData)}`)
}

describe('Sandbox System Operations', () => {
  const createdSandboxes: string[] = []

  afterAll(async () => {
    await Promise.all(
      createdSandboxes.map(async (name) => {
        try {
          await SandboxInstance.delete(name)
        } catch {
          // Ignore cleanup errors
        }
      })
    )
  })

  describe('upgrade', () => {
    it('upgrades sandbox and preview remains responsive', { timeout: 180000 }, async () => {
      const name = uniqueName("system-upgrade")
      console.log(`[TEST] Starting test with sandbox name: ${name}`)

      // Create sandbox with Next.js image
      console.log(`[TEST] Creating sandbox with blaxel/nextjs:latest image...`)
      const createStart = Date.now()
      const sandbox = await SandboxInstance.create({
        name,
        image: "blaxel/nextjs:latest",
        memory: 4096,
        region: defaultRegion,
        ports: [{ target: 3000 }],
        labels: defaultLabels,
      })
      createdSandboxes.push(name)
      console.log(`[TEST] Sandbox created in ${Date.now() - createStart}ms`)

      const sandboxHost = sandbox.metadata?.url
      console.log(`[TEST] Sandbox host: ${sandboxHost}`)
      expect(sandboxHost).toBeDefined()

      // Do initial health check
      console.log(`[TEST] Performing initial health check...`)
      const initialHealthResponse = await fetch(`${sandboxHost}/health`, {
        method: "GET",
        headers: settings.headers,
      })
      const initialHealthData = await initialHealthResponse.json()
      console.log(`[TEST] Initial health check status: ${initialHealthResponse.status}, data:`, initialHealthData)
      expect(initialHealthResponse.status).toBe(200)

      // Start the Next.js dev server
      console.log(`[TEST] Starting Next.js dev server...`)
      const devServerStart = Date.now()
      await sandbox.process.exec({
        name: "nextjs-dev",
        command: "npm run dev -- --port 3000",
        workingDir: "/blaxel/app",
        waitForPorts: [3000],
      })
      console.log(`[TEST] Next.js dev server started in ${Date.now() - devServerStart}ms`)

      // Create a public preview on port 3000
      console.log(`[TEST] Creating preview on port 3000...`)
      const preview = await sandbox.previews.create({
        metadata: { name: "upgrade-test-preview" },
        spec: {
          port: 3000,
          public: true,
        },
      })

      expect(preview.spec.url).toBeDefined()
      const previewUrl = preview.spec.url!
      console.log(`[TEST] Preview created with URL: ${previewUrl}`)

      // Wait for preview to be ready and verify it's responsive
      console.log(`[TEST] Waiting for preview to be ready...`)
      let previewReady = false
      const maxWaitTime = 30000
      const startTime = Date.now()

      while (Date.now() - startTime < maxWaitTime) {
        try {
          const response = await fetch(previewUrl)
          console.log(`[TEST] Preview check - status: ${response.status} (elapsed: ${Date.now() - startTime}ms)`)
          if (response.status === 200) {
            previewReady = true
            break
          }
        } catch (error: unknown) {
          console.log(`[TEST] Preview check - error: ${String(error)} (elapsed: ${Date.now() - startTime}ms)`)
        }
        await sleep(1000)
      }

      console.log(`[TEST] Preview ready: ${previewReady} (took ${Date.now() - startTime}ms)`)
      expect(previewReady).toBe(true)

      // Verify preview is accessible before upgrade and capture content
      console.log(`[TEST] Verifying preview is accessible before upgrade...`)
      const preUpgradeResponse = await fetch(previewUrl)
      console.log(`[TEST] Pre-upgrade preview status: ${preUpgradeResponse.status}`)
      expect(preUpgradeResponse.status).toBe(200)
      const preUpgradeContent = await preUpgradeResponse.text()
      console.log(`[TEST] Pre-upgrade preview content length: ${preUpgradeContent.length} bytes`)

      // Upgrade the sandbox system
      console.log(`[TEST] Calling sandbox.system.upgrade({ version: ${VERSION} })...`)
      const upgradeStart = Date.now()
      const upgradeResult = await sandbox.system.upgrade({ version: VERSION })
      console.log(`[TEST] Upgrade call completed in ${Date.now() - upgradeStart}ms, result:`, upgradeResult)
      expect(upgradeResult).toBeDefined()

      // Wait for health to show upgrade count > 0
      const healthData = await waitForUpgradeComplete(sandboxHost!, maxWaitTime)
      expect(healthData.upgradeCount).toBeGreaterThan(0)

      // Wait a bit for everything to stabilize after upgrade
      console.log(`[TEST] Waiting 2s for stabilization...`)
      await sleep(5000)

      // Verify preview URL is still responsive after upgrade
      console.log(`[TEST] Verifying preview is still responsive after upgrade...`)
      const postUpgradeResponse = await fetch(previewUrl)
      console.log(`[TEST] Post-upgrade preview status: ${postUpgradeResponse.status}`)
      expect(postUpgradeResponse.status).toBe(200)

      // Verify we can still read content from the preview and compare sizes
      const postUpgradeContent = await postUpgradeResponse.text()
      console.log(`[TEST] Post-upgrade preview content length: ${postUpgradeContent.length} bytes`)
      expect(postUpgradeContent).toBeDefined()
      expect(postUpgradeContent.length).toBeGreaterThan(0)

      // Verify the content size is similar before and after upgrade (allow delta of 200 bytes)
      const sizeDelta = Math.abs(postUpgradeContent.length - preUpgradeContent.length)
      console.log(`[TEST] Comparing content sizes - pre: ${preUpgradeContent.length}, post: ${postUpgradeContent.length}, delta: ${sizeDelta}`)
      expect(sizeDelta).toBeLessThanOrEqual(200)

      console.log(`[TEST] Test completed successfully!`)
    })

    it('upgrades sandbox and running process persists and completes on time', { timeout: 120000 }, async () => {
      const name = uniqueName("system-upgrade-process")
      console.log(`[TEST] Starting process persistence test with sandbox name: ${name}`)

      // Create sandbox
      console.log(`[TEST] Creating sandbox...`)
      const createStart = Date.now()
      const sandbox = await SandboxInstance.create({
        name,
        image: "blaxel/base-image:latest",
        memory: 1024,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      console.log(`[TEST] Sandbox created in ${Date.now() - createStart}ms`)

      // Start a sleep process that will run for 30 seconds
      const sleepDuration = 6
      console.log(`[TEST] Starting sleep process for ${sleepDuration} seconds...`)
      const processStart = Date.now()
      const sleepProcess = await sandbox.process.exec({
        name: "test-sleep",
        command: `sleep ${sleepDuration}`,
        waitForCompletion: false,
      })
      console.log(`[TEST] Sleep process started with name: ${sleepProcess.name}`)
      expect(sleepProcess.name).toBe("test-sleep")

      // Wait a bit to ensure the process is running
      await sleep(2000)

      // Verify the process is running before upgrade
      console.log(`[TEST] Checking process status before upgrade...`)
      const processBeforeUpgrade = await sandbox.process.get("test-sleep")
      console.log(`[TEST] Process status before upgrade: ${processBeforeUpgrade.status}`)
      expect(processBeforeUpgrade.status).toBe("running")

      // Upgrade the sandbox system
      console.log(`[TEST] Calling sandbox.system.upgrade({ version: ${VERSION} })...`)
      const upgradeStart = Date.now()
      const upgradeResult = await sandbox.system.upgrade({ version: VERSION })
      console.log(`[TEST] Upgrade call completed in ${Date.now() - upgradeStart}ms, result:`, upgradeResult)
      expect(upgradeResult).toBeDefined()

      // Wait for the upgrade to complete (check health)
      const sandboxHost = sandbox.metadata?.url
      const healthData = await waitForUpgradeComplete(sandboxHost!, 10000)
      expect(healthData.upgradeCount).toBeGreaterThan(0)

      // Check that the sleep process is still visible in the API after upgrade
      console.log(`[TEST] Checking process status after upgrade...`)
      const processAfterUpgrade = await sandbox.process.get("test-sleep")
      console.log(`[TEST] Process status after upgrade: ${processAfterUpgrade.status}`)
      expect(processAfterUpgrade).toBeDefined()
      // The process should still be running (or completed if we took too long)
      expect(["running", "completed"]).toContain(processAfterUpgrade.status)

      // Calculate remaining time for the sleep to complete
      const elapsedSinceStart = Date.now() - processStart
      const expectedTotalDuration = sleepDuration * 1000
      const remainingTime = expectedTotalDuration - elapsedSinceStart
      console.log(`[TEST] Elapsed since process start: ${elapsedSinceStart}ms, remaining: ${remainingTime}ms`)

      // If the process is still running, wait for it to complete
      if (processAfterUpgrade.status === "running") {
        // Wait for the process to complete with some buffer (2 seconds extra)
        const waitTime = Math.max(remainingTime + 5000, 5000)
        console.log(`[TEST] Waiting ${waitTime}ms for process to complete...`)

        const completedProcess = await sandbox.process.wait("test-sleep", {
          maxWait: waitTime,
          interval: 1000,
        })
        console.log(`[TEST] Process completed with status: ${completedProcess.status}, exitCode: ${completedProcess.exitCode}`)
        expect(completedProcess.status).toBe("completed")
        expect(completedProcess.exitCode).toBe(0)
      }

      // Verify the process completed in roughly the expected time (within 10 seconds tolerance)
      const totalDuration = Date.now() - processStart
      console.log(`[TEST] Total duration from process start to completion: ${totalDuration}ms`)
      console.log(`[TEST] Expected duration: ~${expectedTotalDuration}ms`)

      // The process should have completed close to the expected time
      // Allow 15 seconds tolerance for upgrade overhead
      const tolerance = 15000
      expect(totalDuration).toBeGreaterThanOrEqual(expectedTotalDuration - 2000) // At least 28 seconds
      expect(totalDuration).toBeLessThanOrEqual(expectedTotalDuration + tolerance) // At most 45 seconds

      console.log(`[TEST] Process persistence test completed successfully!`)
    })
  })
})
