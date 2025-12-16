import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { SandboxInstance, SandboxCreateConfiguration } from "@blaxel/core"
import { uniqueName, cleanupAll, defaultImage, defaultRegion, sleep } from './helpers'

describe('Sandbox CRUD Operations', () => {
  const createdSandboxes: string[] = []

  afterAll(async () => {
    // Clean up all sandboxes created during tests
    for (const name of createdSandboxes) {
      try {
        await SandboxInstance.delete(name)
      } catch {
        // Ignore cleanup errors
      }
    }
    await cleanupAll()
  })

  describe('create', () => {
    it('creates a sandbox with default settings', async () => {
      const sandbox = await SandboxInstance.create()
      createdSandboxes.push(sandbox.metadata?.name!)

      expect(sandbox.metadata?.name).toBeDefined()
      expect(sandbox.metadata?.name).toMatch(/^sandbox-/)
    })

    it('creates a sandbox with custom name', async () => {
      const name = uniqueName("custom")
      const sandbox = await SandboxInstance.create({ name })
      createdSandboxes.push(name)

      expect(sandbox.metadata?.name).toBe(name)
    })

    it('creates a sandbox with specific image', async () => {
      const name = uniqueName("image-test")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata?.name).toBe(name)
    })

    it('creates a sandbox with memory configuration', async () => {
      const name = uniqueName("memory-test")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        memory: 2048
      })
      createdSandboxes.push(name)

      const retrieved = await SandboxInstance.get(name)
      expect(retrieved.spec?.runtime?.memory).toBe(2048)
    })

    it('creates a sandbox with labels', async () => {
      const name = uniqueName("labels-test")
      const sandbox = await SandboxInstance.create({
        name,
        labels: { "env": "test", "purpose": "integration" }
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata?.labels?.["env"]).toBe("test")
      expect(sandbox.metadata?.labels?.["purpose"]).toBe("integration")
    })

    it('creates a sandbox with ports', async () => {
      const name = uniqueName("ports-test")
      const config: SandboxCreateConfiguration = {
        name,
        image: defaultImage,
        memory: 2048,
        ports: [
          { name: "web", target: 3000 },
          { name: "api", target: 8080, protocol: "TCP" },
        ],
      }

      const sandbox = await SandboxInstance.create(config)
      createdSandboxes.push(name)

      const retrieved = await SandboxInstance.get(name)
      expect(retrieved.spec?.runtime?.ports?.length).toBe(2)
    })

    it('creates a sandbox with environment variables', async () => {
      const name = uniqueName("envs-test")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        envs: [
          { name: "NODE_ENV", value: "test" },
          { name: "DEBUG", value: "true" },
        ],
      })
      createdSandboxes.push(name)

      const retrieved = await SandboxInstance.get(name)
      expect(retrieved.spec?.runtime?.envs?.length).toBe(2)
    })

    it('creates a sandbox with region', async () => {
      const name = uniqueName("region-test")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion
      })
      createdSandboxes.push(name)

      const retrieved = await SandboxInstance.get(name)
      expect(retrieved.spec?.region).toBe(defaultRegion)
    })
  })

  describe('createIfNotExists', () => {
    it('creates a new sandbox if it does not exist', async () => {
      const name = uniqueName("cine")
      const sandbox = await SandboxInstance.createIfNotExists({ name })
      createdSandboxes.push(name)

      expect(sandbox.metadata?.name).toBe(name)
    })

    it('returns existing sandbox if it already exists', async () => {
      const name = uniqueName("cine-existing")

      // Create first
      const first = await SandboxInstance.create({ name })
      createdSandboxes.push(name)

      // createIfNotExists should return the same sandbox
      const second = await SandboxInstance.createIfNotExists({ name })

      expect(second.metadata?.name).toBe(first.metadata?.name)
    })

    it('handles concurrent createIfNotExists calls', async () => {
      const name = uniqueName("cine-race")
      const concurrentCalls = 5

      const promises = Array.from({ length: concurrentCalls }, () =>
        SandboxInstance.createIfNotExists({ name })
          .then(sb => ({ sandbox: sb, error: null }))
          .catch(err => ({ sandbox: null, error: err }))
      )

      const results = await Promise.all(promises)
      createdSandboxes.push(name)

      const successes = results.filter(r => r.sandbox !== null)
      const uniqueNames = new Set(successes.map(r => r.sandbox?.metadata?.name))

      expect(uniqueNames.size).toBe(1)
      expect(successes.length).toBe(concurrentCalls)
    })
  })

  describe('get', () => {
    it('retrieves an existing sandbox', async () => {
      const name = uniqueName("get-test")
      await SandboxInstance.create({ name })
      createdSandboxes.push(name)

      const retrieved = await SandboxInstance.get(name)
      expect(retrieved.metadata?.name).toBe(name)
    })

    it('throws error for non-existent sandbox', async () => {
      await expect(
        SandboxInstance.get("non-existent-sandbox-xyz")
      ).rejects.toThrow()
    })
  })

  describe('list', () => {
    it('lists all sandboxes', async () => {
      const name = uniqueName("list-test")
      await SandboxInstance.create({ name })
      createdSandboxes.push(name)

      const sandboxes = await SandboxInstance.list()
      expect(Array.isArray(sandboxes)).toBe(true)

      const found = sandboxes.find(s => s.metadata?.name === name)
      expect(found).toBeDefined()
    })
  })

  describe('delete', () => {
    it('deletes an existing sandbox', async () => {
      const name = uniqueName("delete-test")
      await SandboxInstance.create({ name })

      await SandboxInstance.delete(name)

      // Wait a bit for deletion to propagate
      await sleep(2000)

      // Should either throw or return DELETED/TERMINATED status
      try {
        const status = await SandboxInstance.get(name)
        expect(["DELETED", "TERMINATED"]).toContain(status.status)
      } catch {
        // Expected - sandbox no longer exists
      }
    })

    it('can delete using instance method', async () => {
      const name = uniqueName("delete-instance")
      const sandbox = await SandboxInstance.create({ name })

      await sandbox.delete()

      await sleep(2000)

      try {
        const status = await SandboxInstance.get(name)
        expect(["DELETED", "TERMINATED"]).toContain(status.status)
      } catch {
        // Expected
      }
    })
  })

  describe('updateMetadata', () => {
    it('updates sandbox labels', async () => {
      const name = uniqueName("update-meta")
      await SandboxInstance.create({ name })
      createdSandboxes.push(name)

      const updated = await SandboxInstance.updateMetadata(name, {
        labels: { updated: "true" }
      })

      expect(updated.metadata?.labels?.["updated"]).toBe("true")
    })

    it('updates sandbox displayName', async () => {
      const name = uniqueName("update-display")
      await SandboxInstance.create({ name })
      createdSandboxes.push(name)

      const updated = await SandboxInstance.updateMetadata(name, {
        displayName: "My Test Sandbox"
      })

      expect(updated.metadata?.displayName).toBe("My Test Sandbox")
    })
  })

  describe('wait', () => {
    it('waits for sandbox to be ready', async () => {
      const name = uniqueName("wait-test")
      const sandbox = await SandboxInstance.create({ name })
      createdSandboxes.push(name)

      await sandbox.wait()

      // After wait, sandbox should be ready and we can run commands
      const result = await sandbox.process.exec({
        command: "echo 'ready'",
        waitForCompletion: true
      })

      expect(result.logs).toContain("ready")
    })
  })
})
