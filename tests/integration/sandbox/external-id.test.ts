import {
  SandboxInstance,
  createSandbox,
  getSandbox,
  getSandboxByExternalId,
  listSandboxes,
  updateSandbox,
} from "@blaxel/core"
import type { Sandbox } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName, waitForSandboxDeletion, sleep } from './helpers.js'

/**
 * Creates a sandbox with an externalId using the generated SDK client.
 */
async function createSandboxWithExternalId(name: string, externalId: string): Promise<Sandbox> {
  const { data } = await createSandbox({
    body: {
      metadata: {
        name,
        labels: defaultLabels,
        externalId,
      },
      spec: {
        runtime: {
          image: defaultImage,
        },
        region: defaultRegion,
      },
    },
    throwOnError: true,
  })
  return data
}

/**
 * Updates a sandbox's externalId via the generated SDK client (preserves other fields).
 */
async function updateSandboxExternalId(name: string, externalId: string): Promise<Sandbox> {
  const { data: current } = await getSandbox({
    path: { sandboxName: name },
    throwOnError: true,
  })

  const { data } = await updateSandbox({
    path: { sandboxName: name },
    body: {
      ...current,
      metadata: { ...current.metadata, externalId },
    },
    throwOnError: true,
  })
  return data
}

describe('Sandbox externalId', () => {
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

  describe('create with externalId', () => {
    it('creates a sandbox with externalId in metadata', async () => {
      const name = uniqueName("ext-id-create")
      const externalId = `ext-${Date.now()}`

      await createSandboxWithExternalId(name, externalId)
      createdSandboxes.push(name)

      // Verify via GET that externalId is persisted
      const { data: sandbox } = await getSandbox({
        path: { sandboxName: name },
        throwOnError: true,
      })
      expect(sandbox.metadata.externalId).toBe(externalId)
    })

    it('creates a sandbox without externalId (optional field)', async () => {
      const name = uniqueName("ext-id-none")
      await SandboxInstance.create({ name, region: defaultRegion, labels: defaultLabels })
      createdSandboxes.push(name)

      const { data: sandbox } = await getSandbox({
        path: { sandboxName: name },
        throwOnError: true,
      })
      // externalId should be empty or not set
      expect(sandbox.metadata.externalId || "").toBe("")
    })
  })

  describe('getSandboxByExternalId', () => {
    it('returns the sandbox by externalId', async () => {
      const name = uniqueName("ext-id-get")
      const externalId = `get-${Date.now()}`

      await createSandboxWithExternalId(name, externalId)
      createdSandboxes.push(name)

      const { data: sandbox } = await getSandboxByExternalId({
        path: { externalId },
        throwOnError: true,
      })
      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.metadata.externalId).toBe(externalId)
    })

    it('returns 404 for non-existent externalId', async () => {
      const { response } = await getSandboxByExternalId({
        path: { externalId: `does-not-exist-${Date.now()}` },
      })
      expect(response.status).toBe(404)
    })

    it('returns the most recent non-terminated sandbox when multiple exist', async () => {
      const externalId = `multi-${Date.now()}`
      const name1 = uniqueName("ext-id-old")
      const name2 = uniqueName("ext-id-new")

      // Create first sandbox with externalId
      await createSandboxWithExternalId(name1, externalId)
      createdSandboxes.push(name1)

      // Wait briefly to ensure ordering by createdAt
      await sleep(1000)

      // Delete first sandbox so it becomes terminated
      await SandboxInstance.delete(name1)
      await waitForSandboxDeletion(name1)

      // Create second sandbox with same externalId
      await createSandboxWithExternalId(name2, externalId)
      createdSandboxes.push(name2)

      // by-external-id should return the second (alive) one
      const { data: sandbox } = await getSandboxByExternalId({
        path: { externalId },
        throwOnError: true,
      })
      expect(sandbox.metadata.name).toBe(name2)
    })

    it('hides terminated sandboxes', async () => {
      const name = uniqueName("ext-id-term")
      const externalId = `term-${Date.now()}`

      await createSandboxWithExternalId(name, externalId)
      createdSandboxes.push(name)

      // Delete the sandbox
      await SandboxInstance.delete(name)
      await waitForSandboxDeletion(name)

      // by-external-id should return 404 since it's terminated
      const { response } = await getSandboxByExternalId({
        path: { externalId },
      })
      expect(response.status).toBe(404)
    })
  })

  describe('listSandboxes with externalId filter', () => {
    it('filters sandboxes by externalId query param', async () => {
      const name = uniqueName("ext-id-filter")
      const externalId = `filter-${Date.now()}`

      await createSandboxWithExternalId(name, externalId)
      createdSandboxes.push(name)

      const { data } = await listSandboxes({
        query: { externalId },
        throwOnError: true,
      })
      const sandboxes = Array.isArray(data) ? data : (data?.data ?? [])
      expect(sandboxes.length).toBeGreaterThanOrEqual(1)

      const found = sandboxes.find((s) => s.metadata.name === name)
      expect(found).toBeDefined()
      expect(found!.metadata.externalId).toBe(externalId)
    })

    it('returns empty list for non-existent externalId', async () => {
      const { data } = await listSandboxes({
        query: { externalId: `nonexistent-${Date.now()}` },
        throwOnError: true,
      })
      const sandboxes = Array.isArray(data) ? data : (data?.data ?? [])
      expect(sandboxes.length).toBe(0)
    })

    it('hides terminated sandboxes by default', async () => {
      const name = uniqueName("ext-id-list-term")
      const externalId = `list-term-${Date.now()}`

      await createSandboxWithExternalId(name, externalId)
      createdSandboxes.push(name)

      // Delete it
      await SandboxInstance.delete(name)
      await waitForSandboxDeletion(name)

      // Filtered list should not include the terminated sandbox
      const { data } = await listSandboxes({
        query: { externalId },
        throwOnError: true,
      })
      const sandboxes = Array.isArray(data) ? data : (data?.data ?? [])
      const found = sandboxes.find((s) => s.metadata.name === name)
      expect(found).toBeUndefined()
    })
  })

  describe('update externalId', () => {
    it('updates externalId on an existing sandbox', async () => {
      const name = uniqueName("ext-id-update")
      const externalId1 = `upd1-${Date.now()}`
      const externalId2 = `upd2-${Date.now()}`

      await createSandboxWithExternalId(name, externalId1)
      createdSandboxes.push(name)

      // Update to a new externalId
      await updateSandboxExternalId(name, externalId2)

      // Old externalId should no longer resolve
      const { response: resOld } = await getSandboxByExternalId({
        path: { externalId: externalId1 },
      })
      expect(resOld.status).toBe(404)

      // New externalId should work
      const { data: sandbox } = await getSandboxByExternalId({
        path: { externalId: externalId2 },
        throwOnError: true,
      })
      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.metadata.externalId).toBe(externalId2)
    })

    it('preserves externalId when omitted in update', async () => {
      const name = uniqueName("ext-id-preserve")
      const externalId = `preserve-${Date.now()}`

      await createSandboxWithExternalId(name, externalId)
      createdSandboxes.push(name)

      // Update labels only (don't touch externalId) via SDK
      await SandboxInstance.updateMetadata(name, {
        labels: { ...defaultLabels, updated: "true" },
      })

      // externalId should still be there
      const { data: sandbox } = await getSandboxByExternalId({
        path: { externalId },
        throwOnError: true,
      })
      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.metadata.externalId).toBe(externalId)
    })
  })

  describe('validation', () => {
    it('rejects externalId longer than 64 characters', async () => {
      const name = uniqueName("ext-id-toolong")
      const longId = 'a'.repeat(65)

      const { response, data } = await createSandbox({
        body: {
          metadata: { name, labels: defaultLabels, externalId: longId },
          spec: { runtime: { image: defaultImage }, region: defaultRegion },
        },
      })

      // Should fail validation
      if (response.ok) {
        // If it somehow passed, clean up
        createdSandboxes.push(name)
      }
      expect(response.ok).toBe(false)
      expect(response.status).toBe(400)
    })

    it('accepts externalId at exactly 64 characters', async () => {
      const name = uniqueName("ext-id-max")
      const maxId = 'a'.repeat(64)

      await createSandboxWithExternalId(name, maxId)
      createdSandboxes.push(name)

      const { data: sandbox } = await getSandboxByExternalId({
        path: { externalId: maxId },
        throwOnError: true,
      })
      expect(sandbox.metadata.externalId).toBe(maxId)
    })

    it('rejects externalId with invalid characters', async () => {
      const name = uniqueName("ext-id-invalid")
      const invalidId = 'has spaces!'

      const { response } = await createSandbox({
        body: {
          metadata: { name, labels: defaultLabels, externalId: invalidId },
          spec: { runtime: { image: defaultImage }, region: defaultRegion },
        },
      })

      if (response.ok) {
        createdSandboxes.push(name)
      }
      expect(response.ok).toBe(false)
      expect(response.status).toBe(400)
    })
  })
})
