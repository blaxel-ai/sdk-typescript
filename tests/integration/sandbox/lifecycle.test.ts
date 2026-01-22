import { describe, it, expect, afterAll } from 'vitest'
import { SandboxInstance, updateSandbox, Sandbox } from "@blaxel/core"
import { uniqueName, defaultImage, defaultLabels, sleep, waitForSandboxDeployed } from './helpers.js'

describe('Sandbox Lifecycle and Expiration', () => {
  const createdSandboxes: string[] = []

  afterAll(async () => {
    // Clean up all sandboxes in parallel
    await Promise.all(
      createdSandboxes.map(async (name) => {
        try {
          await SandboxInstance.delete(name)
        } catch {
          // Ignore
        }
      })
    )
  })

  describe('TTL (time-to-live)', () => {
    it('creates sandbox with TTL string', async () => {
      const name = uniqueName("ttl-string")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        ttl: "5m",
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)

      await sleep(100)

      // Verify sandbox is running
      const status = await SandboxInstance.get(name)
      expect(status.status).not.toBe("TERMINATED")
    })

    it('creates sandbox with expires date', async () => {
      const name = uniqueName("expires-date")
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000) // 5 minutes from now

      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        expires: expiresAt,
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
    })
  })

  describe('expiration policies', () => {
    it('creates sandbox with ttl-max-age policy', async () => {
      const name = uniqueName("maxage-policy")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        lifecycle: {
          expirationPolicies: [
            { type: "ttl-max-age", value: "10m", action: "delete" }
          ]
        },
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
    })

    it('creates sandbox with date expiration policy', async () => {
      const name = uniqueName("date-policy")
      const expirationDate = new Date(Date.now() + 10 * 60 * 1000)

      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        lifecycle: {
          expirationPolicies: [
            { type: "date", value: expirationDate.toISOString(), action: "delete" }
          ]
        },
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
    })

    it('creates sandbox with ttl-idle policy', async () => {
      const name = uniqueName("idle-policy")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        lifecycle: {
          expirationPolicies: [
            { type: "ttl-idle", value: "5m", action: "delete" }
          ]
        },
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
    })

    it('creates sandbox with multiple policies', async () => {
      const name = uniqueName("multi-policy")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        lifecycle: {
          expirationPolicies: [
            { type: "ttl-idle", value: "5m", action: "delete" },
            { type: "ttl-max-age", value: "30m", action: "delete" }
          ]
        },
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
    })

    it('supports various duration formats', async () => {
      const durations = ["30s", "5m", "1h"]

      for (const duration of durations) {
        const name = uniqueName(`dur-${duration.replace(/\D/g, '')}`)
        const sandbox = await SandboxInstance.create({
          name,
          image: defaultImage,
          lifecycle: {
            expirationPolicies: [
              { type: "ttl-max-age", value: duration, action: "delete" }
            ]
          },
          labels: defaultLabels,
        })
        createdSandboxes.push(name)

        expect(sandbox.metadata.name).toBe(name)
      }
    })
  })

  describe('TTL expiration behavior', { timeout: 180000 }, () => {
    it('sandbox terminates after TTL expires', async () => {
      const name = uniqueName("ttl-expire")
      await SandboxInstance.create({
        name,
        image: defaultImage,
        ttl: "1s",
        labels: defaultLabels,
      })
      // Don't add to createdSandboxes - we expect it to auto-delete

      // Wait for TTL + buffer (cron runs every minute)
      await sleep(1100)

      // This should not fail
      const sbx = await SandboxInstance.create({name, labels: defaultLabels})
      expect(sbx.metadata.name).toBe(name)
      createdSandboxes.push(name)
    })
  })

  describe('snapshot configuration', () => {
    it('creates sandbox with snapshots enabled', async () => {
      const name = uniqueName("snapshot-on")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        snapshotEnabled: true,
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
    })

    it('creates sandbox with snapshots disabled', async () => {
      const name = uniqueName("snapshot-off")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        snapshotEnabled: false,
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
    })
  })

  describe('updateTtl preserves sandbox state', () => {
    it('updateTtl does not recreate sandbox - files are preserved', async () => {
      const name = uniqueName("update-ttl")
      const testFilePath = "/tmp/ttl-test-file.txt"
      const testContent = `unique-content-${Date.now()}`

      // Create sandbox with initial TTL
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        ttl: "10m",
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)

      // Write a file to the sandbox
      await sandbox.fs.write(testFilePath, testContent)

      // Verify file was written
      const contentBefore = await sandbox.fs.read(testFilePath)
      expect(contentBefore).toBe(testContent)

      // Update TTL to a new value
      await SandboxInstance.updateTtl(name, "30m")

      // Wait for sandbox to be deployed after update
      await waitForSandboxDeployed(name)
      const updatedSandbox = await SandboxInstance.get(name)

      // Verify sandbox still exists and has same name
      expect(updatedSandbox.metadata.name).toBe(name)

      // CRITICAL: Verify the file still exists with same content
      // If the sandbox was recreated, this file would not exist
      const contentAfter = await updatedSandbox.fs.read(testFilePath)
      expect(contentAfter).toBe(testContent)
    })

    it('updateTtl multiple times preserves files', async () => {
      const name = uniqueName("multi-ttl")
      const testFilePath = "/tmp/multi-ttl-test.txt"
      const testContent = `multi-update-content-${Date.now()}`

      // Create sandbox
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        ttl: "5m",
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      // Write a file
      await sandbox.fs.write(testFilePath, testContent)

      // Update TTL multiple times
      await SandboxInstance.updateTtl(name, "10m")
      await waitForSandboxDeployed(name)

      await SandboxInstance.updateTtl(name, "15m")
      await waitForSandboxDeployed(name)

      await SandboxInstance.updateTtl(name, "20m")
      await waitForSandboxDeployed(name)
      const finalSandbox = await SandboxInstance.get(name)

      // File should still be there
      const content = await finalSandbox.fs.read(testFilePath)
      expect(content).toBe(testContent)
    })
  })

  describe('updateLifecycle preserves sandbox state', () => {
    it('updateLifecycle does not recreate sandbox - files are preserved', async () => {
      const name = uniqueName("update-lifecycle")
      const testFilePath = "/tmp/lifecycle-test-file.txt"
      const testContent = `lifecycle-content-${Date.now()}`

      // Create sandbox with initial lifecycle policy
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        lifecycle: {
          expirationPolicies: [
            { type: "ttl-max-age", value: "10m", action: "delete" }
          ]
        },
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)

      // Write a file to the sandbox
      await sandbox.fs.write(testFilePath, testContent)

      // Verify file was written
      const contentBefore = await sandbox.fs.read(testFilePath)
      expect(contentBefore).toBe(testContent)

      // Update lifecycle to a new policy
      await SandboxInstance.updateLifecycle(name, {
        expirationPolicies: [
          { type: "ttl-max-age", value: "30m", action: "delete" }
        ]
      })

      // Wait for sandbox to be deployed after update
      await waitForSandboxDeployed(name)
      const updatedSandbox = await SandboxInstance.get(name)

      // Verify sandbox still exists and has same name
      expect(updatedSandbox.metadata.name).toBe(name)

      // CRITICAL: Verify the file still exists with same content
      // If the sandbox was recreated, this file would not exist
      const contentAfter = await updatedSandbox.fs.read(testFilePath)
      expect(contentAfter).toBe(testContent)
    })

    it('updateLifecycle with different policy types preserves files', async () => {
      const name = uniqueName("lifecycle-change")
      const testFilePath = "/tmp/lifecycle-change-test.txt"
      const testContent = `policy-change-content-${Date.now()}`

      // Create sandbox with ttl-idle policy
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        lifecycle: {
          expirationPolicies: [
            { type: "ttl-idle", value: "5m", action: "delete" }
          ]
        },
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      // Write a file
      await sandbox.fs.write(testFilePath, testContent)

      // Change to a different policy type
      await SandboxInstance.updateLifecycle(name, {
        expirationPolicies: [
          { type: "ttl-max-age", value: "20m", action: "delete" },
          { type: "ttl-idle", value: "10m", action: "delete" }
        ]
      })

      // Wait for sandbox to be deployed after update
      await new Promise(resolve => setTimeout(resolve, 200))
      await waitForSandboxDeployed(name)
      const updatedSandbox = await SandboxInstance.get(name)

      // File should still be there
      const content = await updatedSandbox.fs.read(testFilePath)
      expect(content).toBe(testContent)
    })
  })

  describe('updateSandbox with envs triggers reboot and clears ephemeral state', () => {
    it('updating environment variables reboots sandbox and clears files', async () => {
      const name = uniqueName("update-envs")
      const testFilePath = "/tmp/envs-test-file.txt"
      const testContent = `envs-content-${Date.now()}`

      // Create sandbox with initial environment variables
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        envs: [
          { name: "TEST_VAR", value: "initial_value" }
        ],
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)

      // Write a file to the sandbox
      await sandbox.fs.write(testFilePath, testContent)

      // Verify file was written
      const contentBefore = await sandbox.fs.read(testFilePath)
      expect(contentBefore).toBe(testContent)

      // Update environment variables using updateSandbox directly
      const currentSandbox = await SandboxInstance.get(name)
      const body: Sandbox = {
        ...currentSandbox.spec,
        metadata: currentSandbox.metadata,
        spec: {
          ...currentSandbox.spec,
          runtime: {
            ...currentSandbox.spec.runtime,
            envs: [
              { name: "TEST_VAR", value: "updated_value" },
              { name: "NEW_VAR", value: "new_value" }
            ]
          }
        }
      }

      await updateSandbox({
        path: { sandboxName: name },
        body,
        throwOnError: true,
      })

      // Wait for sandbox to be deployed after reboot
      await new Promise(resolve => setTimeout(resolve, 200))
      await waitForSandboxDeployed(name)
      const updatedSandbox = await SandboxInstance.get(name)

      // Verify sandbox still exists and has same name
      expect(updatedSandbox.metadata.name).toBe(name)

      // CRITICAL: Verify the file does NOT exist anymore
      // Updating envs triggers a reboot which clears ephemeral files
      await expect(updatedSandbox.fs.read(testFilePath)).rejects.toThrow()

      // Verify env vars are updated by checking them via process exec
      const result = await updatedSandbox.process.exec({
        command: "echo $TEST_VAR $NEW_VAR",
        waitForCompletion: true
      })
      expect(result.stdout?.trim()).toBe("updated_value new_value")
    })
  })
})
