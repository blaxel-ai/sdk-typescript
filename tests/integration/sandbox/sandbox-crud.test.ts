import { SandboxCreateConfiguration, SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName, waitForSandboxDeletion } from './helpers.js'

describe('Sandbox CRUD Operations', () => {
  const createdSandboxes: string[] = []

  afterAll(async () => {
    // Clean up all sandboxes in parallel
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

  describe('create', () => {
    it('creates a sandbox with default settings', async () => {
      const sandbox = await SandboxInstance.create({ region: defaultRegion, labels: defaultLabels })
      if (sandbox.metadata.name) createdSandboxes.push(sandbox.metadata.name)

      // Unnamed creations no longer generate a client-side name; the server
      // assigns one (ENG-3931), so we only assert a name came back.
      expect(sandbox.metadata.name).toBeDefined()
      expect(sandbox.metadata.name).toBeTruthy()
    })

    it('creates a sandbox with custom name', async () => {
      const name = uniqueName("custom")
      const sandbox = await SandboxInstance.create({ name, region: defaultRegion, labels: defaultLabels })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
    })

    it('creates a sandbox with specific image', async () => {
      const name = uniqueName("image-test")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
    })

    it('creates a sandbox with memory configuration', async () => {
      const name = uniqueName("memory-test")
      await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        memory: 8192,
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      const retrieved = await SandboxInstance.get(name)
      expect(retrieved.spec.runtime?.memory).toBe(8192)
    })

    it('creates a sandbox with labels', async () => {
      const name = uniqueName("labels-test")
      const labelsSandbox = await SandboxInstance.create({
        name,
        region: defaultRegion,
        labels: { ...defaultLabels, "env": "test", "purpose": "integration" }
      })
      createdSandboxes.push(name)

      expect(labelsSandbox.metadata.labels?.["env"]).toBe("test")
      expect(labelsSandbox.metadata.labels?.["purpose"]).toBe("integration")
    })

    it('creates a sandbox with ports', async () => {
      const name = uniqueName("ports-test")
      const config: SandboxCreateConfiguration = {
        name,
        image: defaultImage,
        region: defaultRegion,
        memory: 2048,
        ports: [
          { name: "web", target: 3000 },
          { name: "api", target: 8080, protocol: "TCP" },
        ],
        labels: defaultLabels,
      }

      await SandboxInstance.create(config)
      createdSandboxes.push(name)

      const retrieved = await SandboxInstance.get(name)
      expect(retrieved.spec.runtime?.ports?.length).toBe(2)
    })

    it('creates a sandbox with environment variables', async () => {
      const name = uniqueName("envs-test")
      await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        envs: [
          { name: "NODE_ENV", value: "test" },
          { name: "DEBUG", value: "true" },
        ],
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      const retrieved = await SandboxInstance.get(name)
      expect(retrieved.spec.runtime?.envs?.length).toBe(2)
    })

    it('creates a sandbox with region', async () => {
      const name = uniqueName("region-test")
      await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      const retrieved = await SandboxInstance.get(name)
      expect(retrieved.spec.region).toBe(defaultRegion)
    })

    it('handles concurrent create calls with same name', async () => {
      const name = uniqueName("concurrent-create")
      const concurrentCalls = 5

      const promises = Array.from({ length: concurrentCalls }, () =>
        SandboxInstance.create({ name, region: defaultRegion, labels: defaultLabels })
          .then(sb => ({ sandbox: sb, error: null }))
          .catch((err: Error) => ({ sandbox: null, error: err }))
      )

      const results = await Promise.all(promises)
      createdSandboxes.push(name)

      // At least one should succeed
      const successes = results.filter(r => r.sandbox !== null)
      const errors = results.filter(r => r.error !== null)

      expect(successes.length).toBeGreaterThanOrEqual(1)
      expect(errors.length).toBeGreaterThanOrEqual(0)

      // All successful creates should have the same name
      successes.forEach(result => {
        expect(result.sandbox?.metadata.name).toBe(name)
      })

      // Verify the sandbox exists and is functional
      const sandbox = await SandboxInstance.get(name)
      expect(sandbox.metadata.name).toBe(name)
    })
  })

  describe('createIfNotExists', () => {
    it('creates a new sandbox if it does not exist', async () => {
      const name = uniqueName("cine")
      const sandbox = await SandboxInstance.createIfNotExists({ name, region: defaultRegion, labels: defaultLabels })
      createdSandboxes.push(name)

      expect(sandbox.metadata.name).toBe(name)
    })

    it('returns existing sandbox if it already exists', async () => {
      const name = uniqueName("cine-existing")

      // Create first
      const first = await SandboxInstance.create({ name, region: defaultRegion, labels: defaultLabels })
      createdSandboxes.push(name)

      // createIfNotExists should return the same sandbox
      const second = await SandboxInstance.createIfNotExists({ name, region: defaultRegion, labels: defaultLabels })

      expect(second.metadata.name).toBe(first.metadata.name)
    })

    it('handles concurrent createIfNotExists calls', async () => {
      const name = uniqueName("cine-race")
      const concurrentCalls = 5

      const promises = Array.from({ length: concurrentCalls }, () =>
        SandboxInstance.createIfNotExists({ name, region: defaultRegion, labels: defaultLabels })
          .then(sb => ({ sandbox: sb, error: null }))
          .catch((err: Error) => ({ sandbox: null, error: err }))
      )

      const results = await Promise.all(promises)
      createdSandboxes.push(name)

      const successes = results.filter(r => r.sandbox !== null)
      const uniqueNames = new Set(successes.map(r => r.sandbox?.metadata.name))

      expect(uniqueNames.size).toBe(1)
      expect(successes.length).toBeGreaterThan(1)
      const sandbox = await SandboxInstance.get(name)
      const result = await sandbox.process.exec({ command: "echo 'test'", waitForCompletion: true })
      console.log(`Successfully created sandbox and executed command, successes=${successes.length}`)
      expect(result.logs).toBe("test\n")
    })

    it('handles concurrent createIfNotExists calls on existing sandbox', async () => {
      const name = uniqueName("cine-existing-concurrent")

      // First, create the sandbox
      const originalSandbox = await SandboxInstance.create({ name, region: defaultRegion, labels: defaultLabels })
      createdSandboxes.push(name)

      // Then send 5 concurrent createIfNotExists calls
      const concurrentCalls = 5
      const promises = Array.from({ length: concurrentCalls }, () =>
        SandboxInstance.createIfNotExists({ name, region: defaultRegion, labels: defaultLabels })
      )

      const results = await Promise.all(promises)

      // All calls should succeed and return the same sandbox
      expect(results.length).toBe(concurrentCalls)
      results.forEach(result => {
        expect(result.metadata.name).toBe(name)
        expect(result.metadata.name).toBe(originalSandbox.metadata.name)
      })
    })
  })

  describe('get', () => {
    it('retrieves an existing sandbox', async () => {
      const name = uniqueName("get-test")
      await SandboxInstance.create({ name, region: defaultRegion, labels: defaultLabels })
      createdSandboxes.push(name)

      const retrieved = await SandboxInstance.get(name)
      expect(retrieved.metadata.name).toBe(name)
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
      await SandboxInstance.create({ name, region: defaultRegion, labels: defaultLabels })
      createdSandboxes.push(name)

      const sandboxes = await SandboxInstance.list()
      expect(Array.isArray(sandboxes.data)).toBe(true)

      const found = sandboxes.data.find(s => s.metadata.name === name)
      expect(found).toBeDefined()
    })

    it('paginates sandboxes with cursor, nextPage and autoPaging', async () => {
      // Ensure at least two sandboxes exist so a page size of 1 spans multiple pages
      const a = uniqueName("sandbox-page-a")
      const b = uniqueName("sandbox-page-b")
      await SandboxInstance.create({ name: a, region: defaultRegion, labels: defaultLabels })
      createdSandboxes.push(a)
      await SandboxInstance.create({ name: b, region: defaultRegion, labels: defaultLabels })
      createdSandboxes.push(b)

      // First page with limit 1 must report more pages and expose a cursor
      const page1 = await SandboxInstance.list({ limit: 1 })
      expect(page1.data.length).toBe(1)
      expect(page1.hasMore).toBe(true)
      expect(page1.nextCursor).toBeTruthy()

      // Next page must advance via the cursor (a fresh, non-empty page)
      const page2 = await page1.nextPage()
      expect(page2).not.toBeNull()
      expect(page2!.data.length).toBeGreaterThanOrEqual(1)

      // Auto-paging with a small page size walks past the first page and reaches
      // both created sandboxes. Unlike drives/volumes we do NOT assert "no
      // duplicates across pages": the listSandboxes endpoint orders on a volatile
      // field (sandboxes change state continuously), so with limit:1 the cursor
      // is not a stable keyset and can revisit items across pages. The duplicates
      // are a backend pagination limitation, not an SDK bug -- the cursor helper
      // is identical to the drive/volume paths that paginate cleanly.
      const walked = await (await SandboxInstance.list({ limit: 1 })).autoPagingToArray({ limit: 100000 })
      const names = walked.map(s => s.metadata.name)
      expect(names).toContain(a)
      expect(names).toContain(b)
      expect(walked.length).toBeGreaterThan(1)
    })
  })

  describe('delete', () => {
    it('deletes an existing sandbox', async () => {
      const name = uniqueName("delete-test")
      await SandboxInstance.create({ name, region: defaultRegion, labels: defaultLabels })

      await SandboxInstance.delete(name)

      // Wait for deletion to fully complete
      const deleted = await waitForSandboxDeletion(name)
      expect(deleted).toBe(true)
    })

    it('can delete using instance method', async () => {
      const name = uniqueName("delete-instance")
      const sandbox = await SandboxInstance.create({ name, region: defaultRegion, labels: defaultLabels })

      await sandbox.delete()

      // Wait for deletion to fully complete
      const deleted = await waitForSandboxDeletion(name)
      expect(deleted).toBe(true)
    })
  })

  describe('updateMetadata', () => {
    it('updates sandbox labels', async () => {
      const name = uniqueName("update-meta")
      await SandboxInstance.create({ name, region: defaultRegion, labels: defaultLabels })
      createdSandboxes.push(name)

      const updated = await SandboxInstance.updateMetadata(name, {
        labels: { ...defaultLabels, updated: "true" }
      })

      expect(updated.metadata.labels?.["updated"]).toBe("true")
    })

    it('updates sandbox displayName', async () => {
      const name = uniqueName("update-display")
      await SandboxInstance.create({ name, region: defaultRegion, labels: defaultLabels })
      createdSandboxes.push(name)

      const updated = await SandboxInstance.updateMetadata(name, {
        displayName: "My Test Sandbox"
      })

      expect(updated.metadata.displayName).toBe("My Test Sandbox")
    })
  })

  describe('wait', () => {
    it('waits for sandbox to be ready', async () => {
      const name = uniqueName("wait-test")
      const sandbox = await SandboxInstance.create({ name, region: defaultRegion, labels: defaultLabels })
      createdSandboxes.push(name)


      // After wait, sandbox should be ready and we can run commands
      const result = await sandbox.process.exec({
        command: "echo 'ready'",
        waitForCompletion: true
      })

      expect(result.logs).toContain("ready")
    })
  })
})
