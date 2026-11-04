import { SandboxInstance, settings } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultLabels, defaultRegion, sleep, uniqueName } from './helpers.js'
import type { HealthResponse } from "../../../@blaxel/core/src/sandbox/client/types.gen.js"

const VERSION = process.env.BL_ENV === "dev" ? "develop" : "latest"

/**
 * Wait for sandbox upgrade to complete by polling the health endpoint
 * Returns the health data when upgrade count > 0, throws if upgrade failed
 */
async function waitForUpgradeComplete(
  sandboxHost: string,
  maxWaitTime: number = 30000
): Promise<HealthResponse> {
  
  const healthCheckStartTime = Date.now()
  let healthData: HealthResponse | null = null

  while (Date.now() - healthCheckStartTime < maxWaitTime) {
    try {
      const healthResponse = await fetch(`${sandboxHost}/health`, {
        method: "GET",
        headers: settings.headers,
      })
      healthData = await healthResponse.json() as HealthResponse
      
      if (healthData.upgradeCount && healthData.upgradeCount > 0) {
        
        return healthData
      }
      if (healthData?.lastUpgrade?.status === "failed") {
        
        throw new Error(`Upgrade failed: ${JSON.stringify(healthData)}`)
      }
    } catch (error: unknown) {
      // Re-throw upgrade failures
      if (error instanceof Error && error.message.startsWith("Upgrade failed:")) {
        throw error
      }
      
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
      

      // Create sandbox with Next.js image
      
      const createStart = Date.now()
      const sandbox = await SandboxInstance.create({
        name,
        image: "blaxel/nextjs:latest",
        memory: 4096,
        region: defaultRegion,
        ports: [{ target: 3001 }],
        labels: defaultLabels,
      })
      createdSandboxes.push(name)
      

      const sandboxHost = sandbox.metadata?.url
      
      expect(sandboxHost).toBeDefined()

      // Do initial health check
      
      const initialHealthResponse = await fetch(`${sandboxHost}/health`, {
        method: "GET",
        headers: settings.headers,
      })
      const initialHealthData = await initialHealthResponse.json()
      
      expect(initialHealthResponse.status).toBe(200)

      // Start the Next.js dev server
      
      const devServerStart = Date.now()
      await sandbox.process.exec({
        name: "nextjs-dev",
        command: "npm run dev -- --port 3001",
        workingDir: "/blaxel/app",
        waitForPorts: [3001],
      })
      

      // Port 3001: the nextjs image already runs its own dev server on 3000 at boot.

      // Create a public preview on port 3001
      
      const preview = await sandbox.previews.create({
        metadata: { name: "upgrade-test-preview" },
        spec: {
          port: 3001,
          public: true,
        },
      })

      expect(preview.spec.url).toBeDefined()
      const previewUrl = preview.spec.url!
      

      // Wait for preview to be ready and verify it's responsive
      
      let previewReady = false
      const maxWaitTime = 30000
      const startTime = Date.now()

      while (Date.now() - startTime < maxWaitTime) {
        try {
          const response = await fetch(previewUrl)
          
          if (response.status === 200) {
            previewReady = true
            break
          }
        } catch (error: unknown) {
          
        }
        await sleep(1000)
      }

      
      expect(previewReady).toBe(true)

      // Verify preview is accessible before upgrade and capture content
      
      const preUpgradeResponse = await fetch(previewUrl)
      
      expect(preUpgradeResponse.status).toBe(200)
      const preUpgradeContent = await preUpgradeResponse.text()
      

      // Upgrade the sandbox system
      
      const upgradeStart = Date.now()
      const upgradeResult = await sandbox.system.upgrade({ version: VERSION })
      
      expect(upgradeResult).toBeDefined()

      // Wait for health to show upgrade count > 0
      const healthData = await waitForUpgradeComplete(sandboxHost!, maxWaitTime)
      expect(healthData.upgradeCount).toBeGreaterThan(0)

      // Wait a bit for everything to stabilize after upgrade
      
      await sleep(5000)

      // Verify preview URL is still responsive after upgrade
      
      const postUpgradeResponse = await fetch(previewUrl)
      
      expect(postUpgradeResponse.status).toBe(200)

      // Verify we can still read content from the preview and compare sizes
      const postUpgradeContent = await postUpgradeResponse.text()
      
      expect(postUpgradeContent).toBeDefined()
      expect(postUpgradeContent.length).toBeGreaterThan(0)

      // Verify the content size is similar before and after upgrade (allow delta of 200 bytes)
      const sizeDelta = Math.abs(postUpgradeContent.length - preUpgradeContent.length)
      
      expect(sizeDelta).toBeLessThanOrEqual(200)

      
    })

    it('upgrades sandbox and running process persists and completes on time', { timeout: 120000 }, async () => {
      const name = uniqueName("system-upgrade-process")
      

      // Create sandbox
      
      const createStart = Date.now()
      const sandbox = await SandboxInstance.create({
        name,
        image: "blaxel/base-image:latest",
        memory: 1024,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      

      // Start a sleep process that will run for 30 seconds
      const sleepDuration = 6
      
      const processStart = Date.now()
      const sleepProcess = await sandbox.process.exec({
        name: "test-sleep",
        command: `sleep ${sleepDuration}`,
        waitForCompletion: false,
      })
      
      expect(sleepProcess.name).toBe("test-sleep")

      // Wait a bit to ensure the process is running
      await sleep(2000)

      // Verify the process is running before upgrade
      
      const processBeforeUpgrade = await sandbox.process.get("test-sleep")
      
      expect(processBeforeUpgrade.status).toBe("running")

      // Upgrade the sandbox system
      
      const upgradeStart = Date.now()
      const upgradeResult = await sandbox.system.upgrade({ version: VERSION })
      
      expect(upgradeResult).toBeDefined()

      // Wait for the upgrade to complete (check health)
      const sandboxHost = sandbox.metadata?.url
      const healthData = await waitForUpgradeComplete(sandboxHost!, 10000)
      expect(healthData.upgradeCount).toBeGreaterThan(0)

      // Check that the sleep process is still visible in the API after upgrade
      
      const processAfterUpgrade = await sandbox.process.get("test-sleep")
      
      expect(processAfterUpgrade).toBeDefined()
      // The process should still be running (or completed if we took too long)
      expect(["running", "completed"]).toContain(processAfterUpgrade.status)

      // Calculate remaining time for the sleep to complete
      const elapsedSinceStart = Date.now() - processStart
      const expectedTotalDuration = sleepDuration * 1000
      const remainingTime = expectedTotalDuration - elapsedSinceStart
      

      // If the process is still running, wait for it to complete
      if (processAfterUpgrade.status === "running") {
        // Wait for the process to complete with some buffer (2 seconds extra)
        const waitTime = Math.max(remainingTime + 5000, 5000)
        

        const completedProcess = await sandbox.process.wait("test-sleep", {
          maxWait: waitTime,
          interval: 1000,
        })
        
        expect(completedProcess.status).toBe("completed")
        expect(completedProcess.exitCode).toBe(0)
      }

      // Verify the process completed in roughly the expected time (within 10 seconds tolerance)
      const totalDuration = Date.now() - processStart
      
      

      // The process should have completed close to the expected time
      // Allow 15 seconds tolerance for upgrade overhead
      const tolerance = 15000
      expect(totalDuration).toBeGreaterThanOrEqual(expectedTotalDuration - 2000) // At least 28 seconds
      expect(totalDuration).toBeLessThanOrEqual(expectedTotalDuration + tolerance) // At most 45 seconds

      
    })
  })
})
