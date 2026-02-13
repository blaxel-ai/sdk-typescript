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

  describe('expiration behavior', { timeout: 180000 }, () => {
    it('sandbox terminates after TTL string expires', async () => {
      const name = uniqueName("ttl-string-expire")
      const testFile = "/tmp/ttl-string-test-marker.txt"
      const testContent = "this-should-not-persist-ttl-string"

      const firstSandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        ttl: "1s",
        labels: defaultLabels,
      })

      // Write content to the first sandbox
      await firstSandbox.fs.write(testFile, testContent)
      const written = await firstSandbox.fs.read(testFile)
      expect(written).toBe(testContent)

      // Wait for TTL + buffer
      await sleep(1100)

      const retrievedSandbox = await SandboxInstance.get(name)
      expect(retrievedSandbox.status).toBe("TERMINATED")

      // Create a new sandbox with the same name
      const secondSandbox = await SandboxInstance.create({name, labels: defaultLabels})
      expect(secondSandbox.metadata.name).toBe(name)
      createdSandboxes.push(name)

      // Verify the file does not exist in the new sandbox (proves it's recreated from scratch)
      await expect(secondSandbox.fs.read(testFile)).rejects.toThrow()
    })

    it('sandbox terminates after expires date', async () => {
      const name = uniqueName("expires-date-expire")
      const testFile = "/tmp/expires-date-test-marker.txt"
      const testContent = "this-should-not-persist-expires-date"

      const expiresAt = new Date(Date.now() + 1000) // 1 second from now

      const firstSandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        expires: expiresAt,
        labels: defaultLabels,
      })

      // Write content to the first sandbox
      await firstSandbox.fs.write(testFile, testContent)
      const written = await firstSandbox.fs.read(testFile)
      expect(written).toBe(testContent)

      // Wait for expiration + buffer
      await sleep(1100)

      const retrievedSandbox = await SandboxInstance.get(name)
      expect(retrievedSandbox.status).toBe("TERMINATED")

      // Create a new sandbox with the same name
      const secondSandbox = await SandboxInstance.create({name, labels: defaultLabels})
      expect(secondSandbox.metadata.name).toBe(name)
      createdSandboxes.push(name)

      // Verify the file does not exist in the new sandbox (proves it's recreated from scratch)
      await expect(secondSandbox.fs.read(testFile)).rejects.toThrow()
    })

    it('sandbox terminates after lifecycle ttl-max-age policy expires', async () => {
      const name = uniqueName("lifecycle-maxage-expire")
      const testFile = "/tmp/lifecycle-maxage-test-marker.txt"
      const testContent = "this-should-not-persist-lifecycle-maxage"

      const firstSandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        lifecycle: {
          expirationPolicies: [
            { type: "ttl-max-age", value: "1s", action: "delete" }
          ]
        },
        labels: defaultLabels,
      })

      // Write content to the first sandbox
      await firstSandbox.fs.write(testFile, testContent)
      const written = await firstSandbox.fs.read(testFile)
      expect(written).toBe(testContent)

      // Wait for TTL + buffer
      await sleep(1100)

      const retrievedSandbox = await SandboxInstance.get(name)
      expect(retrievedSandbox.status).toBe("TERMINATED")

      // Create a new sandbox with the same name
      const secondSandbox = await SandboxInstance.create({name, labels: defaultLabels})
      expect(secondSandbox.metadata.name).toBe(name)
      createdSandboxes.push(name)

      // Verify the file does not exist in the new sandbox (proves it's recreated from scratch)
      await expect(secondSandbox.fs.read(testFile)).rejects.toThrow()
    })

    it('sandbox terminates after lifecycle ttl-idle policy expires', async () => {
      const name = uniqueName("lifecycle-idle-expire")
      const testFile = "/tmp/lifecycle-idle-test-marker.txt"
      const testContent = "this-should-not-persist-lifecycle-idle"

      const firstSandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        lifecycle: {
          expirationPolicies: [
            { type: "ttl-idle", value: "5s", action: "delete" }
          ]
        },
        labels: defaultLabels,
      })

      // Write content to the first sandbox
      await firstSandbox.fs.write(testFile, testContent)
      const written = await firstSandbox.fs.read(testFile)
      expect(written).toBe(testContent)

      // Wait for idle TTL + buffer
      await sleep(7000)

      const retrievedSandbox = await SandboxInstance.get(name)
      expect(retrievedSandbox.status).toBe("TERMINATED")

      // Create a new sandbox with the same name
      const secondSandbox = await SandboxInstance.create({name, labels: defaultLabels})
      expect(secondSandbox.metadata.name).toBe(name)
      createdSandboxes.push(name)

      // Verify the file does not exist in the new sandbox (proves it's recreated from scratch)
      await expect(secondSandbox.fs.read(testFile)).rejects.toThrow()
    })

    it('sandbox terminates after lifecycle date policy expires', async () => {
      const name = uniqueName("lifecycle-date-expire")
      const testFile = "/tmp/lifecycle-date-test-marker.txt"
      const testContent = "this-should-not-persist-lifecycle-date"

      const expirationDate = new Date(Date.now() + 1000) // 1 second from now

      const firstSandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        lifecycle: {
          expirationPolicies: [
            { type: "date", value: expirationDate.toISOString(), action: "delete" }
          ]
        },
        labels: defaultLabels,
      })

      // Write content to the first sandbox
      await firstSandbox.fs.write(testFile, testContent)
      const written = await firstSandbox.fs.read(testFile)
      expect(written).toBe(testContent)

      // Wait for date expiration + buffer
      await sleep(1100)

      const retrievedSandbox = await SandboxInstance.get(name)
      expect(retrievedSandbox.status).toBe("TERMINATED")

      // Create a new sandbox with the same name
      const secondSandbox = await SandboxInstance.create({name, labels: defaultLabels})
      expect(secondSandbox.metadata.name).toBe(name)
      createdSandboxes.push(name)

      // Verify the file does not exist in the new sandbox (proves it's recreated from scratch)
      await expect(secondSandbox.fs.read(testFile)).rejects.toThrow()
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
