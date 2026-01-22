import { SandboxInstance, settings } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultLabels, defaultRegion, sleep, uniqueName } from './helpers.js'

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

  describe('restart', () => {
    it('restarts sandbox and preview remains responsive', { timeout: 180000 }, async () => {
      const name = uniqueName("system-restart")
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
      // createdSandboxes.push(name)
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
        metadata: { name: "restart-test-preview" },
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

      // Verify preview is accessible before restart
      console.log(`[TEST] Verifying preview is accessible before restart...`)
      const preRestartResponse = await fetch(previewUrl)
      console.log(`[TEST] Pre-restart preview status: ${preRestartResponse.status}`)
      expect(preRestartResponse.status).toBe(200)

      // Restart the sandbox system
      console.log(`[TEST] Calling sandbox.system.restart()...`)
      const restartStart = Date.now()
      const restartResult = await sandbox.system.restart()
      console.log(`[TEST] Restart call completed in ${Date.now() - restartStart}ms, result:`, restartResult)
      expect(restartResult).toBeDefined()

      // Wait for health to show restart count > 0
      console.log(`[TEST] Waiting for health restart count > 0...`)
      let healthRestartCount = 0
      const healthCheckStartTime = Date.now()

      while (Date.now() - healthCheckStartTime < maxWaitTime) {
        try {
          const healthResponse = await fetch(`${sandboxHost}/health`, {
            method: "GET",
            headers: settings.headers,
          })
          const healthData = await healthResponse.json() as { restartCount: number }
          console.log(`[TEST] Health check - restartCount: ${healthData.restartCount} (elapsed: ${Date.now() - healthCheckStartTime}ms)`)
          if (healthData.restartCount > 0) {
            healthRestartCount = healthData.restartCount
            break
          }
        } catch (error: unknown) {
          console.log(`[TEST] Health check error: ${String(error)} (elapsed: ${Date.now() - healthCheckStartTime}ms)`)
        }
        await sleep(500)
      }

      console.log(`[TEST] Health restart count: ${healthRestartCount} (took ${Date.now() - healthCheckStartTime}ms)`)
      expect(healthRestartCount).toBeGreaterThan(0)

      // Wait a bit for everything to stabilize after restart
      console.log(`[TEST] Waiting 2s for stabilization...`)
      await sleep(2000)

      // Verify preview URL is still responsive after restart
      console.log(`[TEST] Verifying preview is still responsive after restart...`)
      const postRestartResponse = await fetch(previewUrl)
      console.log(`[TEST] Post-restart preview status: ${postRestartResponse.status}`)
      expect(postRestartResponse.status).toBe(200)

      // Verify we can still read content from the preview
      const content = await postRestartResponse.text()
      console.log(`[TEST] Post-restart preview content length: ${content.length} bytes`)
      expect(content).toBeDefined()
      expect(content.length).toBeGreaterThan(0)

      console.log(`[TEST] Test completed successfully!`)
    })
  })
})
