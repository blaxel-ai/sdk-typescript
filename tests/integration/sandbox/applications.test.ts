/**
 * Integration test for Application Runtime feature.
 *
 * Tests:
 * 1. Build a sandbox image via SDK
 * 2. Create an application from the built image
 * 3. CRUD operations on applications
 * 4. Wait for application to deploy successfully
 *
 * Requires: BL_WORKSPACE, BL_API_KEY, IMAGE_BUILD=true
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterAll } from 'vitest'
import { ApplicationInstance, ImageInstance, SandboxInstance, deleteApplication, getApplication, listApplications } from "@blaxel/core"
import type { Application } from "@blaxel/core"
import { defaultLabels, defaultRegion, uniqueName, sleep, waitForSandboxDeletion } from './helpers.js'

const IMAGE_BUILD = process.env.IMAGE_BUILD === 'true'

/**
 * Wait for an application to reach a target status.
 */
async function waitForApplicationStatus(
  appName: string,
  targetStatus: string,
  maxAttempts = 60
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const app = await ApplicationInstance.get(appName)
    if (app.status === targetStatus) return true
    if (app.status === "FAILED") {
      console.warn(`Application ${appName} entered FAILED status`)
      return false
    }
    await sleep(2000)
  }
  console.warn(`Timeout waiting for ${appName} to reach ${targetStatus}`)
  return false
}

describe.skipIf(!IMAGE_BUILD)('Application Runtime', () => {
  const createdSandboxes: string[] = []
  const createdApps: string[] = []
  let builtImageName: string

  afterAll(async () => {
    // Clean up applications
    for (const name of createdApps) {
      try {
        await ApplicationInstance.delete(name)
      } catch {
        // Ignore cleanup errors
      }
    }
    // Clean up sandboxes used for image build
    for (const name of createdSandboxes) {
      try {
        await SandboxInstance.delete(name)
        await waitForSandboxDeletion(name)
      } catch {
        // Ignore cleanup errors
      }
    }
  })

  describe('image build', { timeout: 900000 }, () => {
    it('builds a sandbox image that can be used for applications', async () => {
      const sandboxName = uniqueName("app-img-build")
      createdSandboxes.push(sandboxName)

      // Build a simple image with an HTTP server
      const image = ImageInstance.fromRegistry("node:20-slim")
        .workdir("/app")
        .runCommands(
          "echo 'const http = require(\"http\"); const s = http.createServer((req, res) => { res.writeHead(200); res.end(\"hello-from-app\"); }); s.listen(8080, () => console.log(\"listening on 8080\"));' > server.js"
        )
        .expose(8080)

      const sandbox = await image.build({
        name: sandboxName,
        memory: 2048,
        timeout: 600000,
        onStatusChange: (status) => console.log(`  Image build status: ${status}`),
        sandboxVersion: "latest",
      })

      expect(sandbox.metadata?.name).toBe(sandboxName)
      expect(sandbox.status).toBe("DEPLOYED")

      // The image name follows the pattern: sandbox/<sandboxName>:latest
      builtImageName = `sandbox/${sandboxName}:latest`
      console.log(`  Built image: ${builtImageName}`)
    })
  })

  describe('CRUD operations', { timeout: 300000 }, () => {
    it('creates an application from the built image', async () => {
      const appName = uniqueName("app-crud")
      createdApps.push(appName)

      const app = await ApplicationInstance.create({
        name: appName,
        image: builtImageName,
        memory: 2048,
        region: defaultRegion,
        labels: defaultLabels,
      })

      expect(app.name).toBe(appName)
      expect(app.spec?.revisions?.[0]?.image).toBe(builtImageName)
      expect(app.spec?.revisions?.[0]?.memory).toBe(2048)
      expect(app.spec?.region).toBe(defaultRegion)
    })

    it('gets an application by name', async () => {
      const appName = createdApps[0]
      const app = await ApplicationInstance.get(appName)

      expect(app.name).toBe(appName)
      expect(app.metadata.name).toBe(appName)
      expect(app.spec).toBeDefined()
    })

    it('lists applications', async () => {
      const apps = await ApplicationInstance.list()

      expect(apps.length).toBeGreaterThan(0)
      const found = apps.find(a => a.name === createdApps[0])
      expect(found).toBeDefined()
    })

    it('updates an application', async () => {
      const appName = createdApps[0]

      const updated = await ApplicationInstance.update(appName, {
        memory: 4096,
        image: builtImageName,
      })

      expect(updated.spec?.revisions?.[0]?.memory).toBe(4096)
    })

    it('lists application revisions', async () => {
      const appName = createdApps[0]
      const app = await ApplicationInstance.get(appName)
      const revisions = await app.listRevisions()

      expect(Array.isArray(revisions)).toBe(true)
    })

    it('waits for application to deploy', async () => {
      const appName = createdApps[0]
      const deployed = await waitForApplicationStatus(appName, "DEPLOYED")

      expect(deployed).toBe(true)
    })

    it('creates an application with environment variables', async () => {
      const appName = uniqueName("app-envs")
      createdApps.push(appName)

      const app = await ApplicationInstance.create({
        name: appName,
        image: builtImageName,
        memory: 2048,
        region: defaultRegion,
        envs: [
          { name: "NODE_ENV", value: "production" },
          { name: "PORT", value: "8080" },
        ],
        labels: defaultLabels,
      })

      expect(app.name).toBe(appName)
      expect(app.spec?.revisions?.[0]?.envs?.length).toBe(2)
    })

    it('creates an application using raw ApplicationModel', async () => {
      const appName = uniqueName("app-raw")
      createdApps.push(appName)

      const app = await ApplicationInstance.create({
        metadata: {
          name: appName,
          displayName: "Raw App Test",
          labels: defaultLabels,
        },
        spec: {
          enabled: true,
          region: defaultRegion,
          revisions: [{
            image: builtImageName,
            memory: 2048,
          }],
        },
      } as Application)

      expect(app.name).toBe(appName)
      expect(app.metadata.displayName).toBe("Raw App Test")
    })

    it('deletes an application', async () => {
      const appName = createdApps[createdApps.length - 1]
      const result = await ApplicationInstance.delete(appName)

      expect(result).toBeDefined()

      // Verify it's gone or in a terminal state
      await sleep(2000)
      try {
        const app = await ApplicationInstance.get(appName)
        // May still exist briefly during deletion
        expect(["DELETING", "TERMINATED"]).toContain(app.status)
      } catch {
        // 404 = successfully deleted
      }

      // Remove from cleanup list since it's already deleted
      createdApps.pop()
    })
  })
})
