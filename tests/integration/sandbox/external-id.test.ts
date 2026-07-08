import { SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName, waitForSandboxDeletion, sleep } from './helpers.js'

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

      await SandboxInstance.create({ name, externalId, region: defaultRegion, labels: defaultLabels, image: defaultImage })
      createdSandboxes.push(name)

      const sandbox = await SandboxInstance.get(name)
      expect(sandbox.metadata.externalId).toBe(externalId)
    })

    it('creates a sandbox without externalId (optional field)', async () => {
      const name = uniqueName("ext-id-none")
      await SandboxInstance.create({ name, region: defaultRegion, labels: defaultLabels })
      createdSandboxes.push(name)

      const sandbox = await SandboxInstance.get(name)
      expect(sandbox.metadata.externalId || "").toBe("")
    })
  })

  describe('getByExternalId', () => {
    it('returns the sandbox by externalId', async () => {
      const name = uniqueName("ext-id-get")
      const externalId = `get-${Date.now()}`

      await SandboxInstance.create({ name, externalId, region: defaultRegion, labels: defaultLabels, image: defaultImage })
      createdSandboxes.push(name)

      const sandbox = await SandboxInstance.getByExternalId(externalId)
      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.metadata.externalId).toBe(externalId)
    })

    it('returns 404 for non-existent externalId', async () => {
      await expect(
        SandboxInstance.getByExternalId(`does-not-exist-${Date.now()}`)
      ).rejects.toMatchObject({ code: 404 })
    })

    it('returns the most recent non-terminated sandbox when multiple exist', async () => {
      const externalId = `multi-${Date.now()}`
      const name1 = uniqueName("ext-id-old")
      const name2 = uniqueName("ext-id-new")

      await SandboxInstance.create({ name: name1, externalId, region: defaultRegion, labels: defaultLabels, image: defaultImage })
      createdSandboxes.push(name1)

      // Wait briefly to ensure ordering by createdAt
      await sleep(1000)

      // Delete first sandbox so it becomes terminated
      await SandboxInstance.delete(name1)
      await waitForSandboxDeletion(name1)

      await SandboxInstance.create({ name: name2, externalId, region: defaultRegion, labels: defaultLabels, image: defaultImage })
      createdSandboxes.push(name2)

      const sandbox = await SandboxInstance.getByExternalId(externalId)
      expect(sandbox.metadata.name).toBe(name2)
    })

    it('hides terminated sandboxes', async () => {
      const name = uniqueName("ext-id-term")
      const externalId = `term-${Date.now()}`

      await SandboxInstance.create({ name, externalId, region: defaultRegion, labels: defaultLabels, image: defaultImage })
      createdSandboxes.push(name)

      await SandboxInstance.delete(name)
      await waitForSandboxDeletion(name)

      await expect(
        SandboxInstance.getByExternalId(externalId)
      ).rejects.toMatchObject({ code: 404 })
    })
  })

  describe('list with externalId filter', () => {
    it('filters sandboxes by externalId', async () => {
      const name = uniqueName("ext-id-filter")
      const externalId = `filter-${Date.now()}`

      await SandboxInstance.create({ name, externalId, region: defaultRegion, labels: defaultLabels, image: defaultImage })
      createdSandboxes.push(name)

      const page = await SandboxInstance.list({ externalId })
      expect(page.data.length).toBeGreaterThanOrEqual(1)

      const found = page.data.find((s) => s.metadata.name === name)
      expect(found).toBeDefined()
      expect(found!.metadata.externalId).toBe(externalId)
    })

    it('returns empty list for non-existent externalId', async () => {
      const page = await SandboxInstance.list({ externalId: `nonexistent-${Date.now()}` })
      expect(page.data.length).toBe(0)
    })

    it('hides terminated sandboxes by default', async () => {
      const name = uniqueName("ext-id-list-term")
      const externalId = `list-term-${Date.now()}`

      await SandboxInstance.create({ name, externalId, region: defaultRegion, labels: defaultLabels, image: defaultImage })
      createdSandboxes.push(name)

      await SandboxInstance.delete(name)
      await waitForSandboxDeletion(name)

      const page = await SandboxInstance.list({ externalId })
      const found = page.data.find((s) => s.metadata.name === name)
      expect(found).toBeUndefined()
    })
  })

  describe('update externalId', () => {
    it('updates externalId on an existing sandbox', async () => {
      const name = uniqueName("ext-id-update")
      const externalId1 = `upd1-${Date.now()}`
      const externalId2 = `upd2-${Date.now()}`

      await SandboxInstance.create({ name, externalId: externalId1, region: defaultRegion, labels: defaultLabels, image: defaultImage })
      createdSandboxes.push(name)

      await SandboxInstance.updateMetadata(name, { externalId: externalId2 })

      // Old externalId should no longer resolve
      await expect(
        SandboxInstance.getByExternalId(externalId1)
      ).rejects.toMatchObject({ code: 404 })

      // New externalId should work
      const sandbox = await SandboxInstance.getByExternalId(externalId2)
      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.metadata.externalId).toBe(externalId2)
    })

    it('preserves externalId when omitted in update', async () => {
      const name = uniqueName("ext-id-preserve")
      const externalId = `preserve-${Date.now()}`

      await SandboxInstance.create({ name, externalId, region: defaultRegion, labels: defaultLabels, image: defaultImage })
      createdSandboxes.push(name)

      // Update labels only (don't touch externalId)
      await SandboxInstance.updateMetadata(name, {
        labels: { ...defaultLabels, updated: "true" },
      })

      const sandbox = await SandboxInstance.getByExternalId(externalId)
      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.metadata.externalId).toBe(externalId)
    })
  })

  describe('validation', () => {
    it('rejects externalId longer than 64 characters', async () => {
      const name = uniqueName("ext-id-toolong")
      const longId = 'a'.repeat(65)

      await expect(
        SandboxInstance.create({
          name,
          externalId: longId,
          region: defaultRegion,
          labels: defaultLabels,
          image: defaultImage,
        })
      ).rejects.toBeDefined()
    })

    it('accepts externalId at exactly 64 characters', async () => {
      const name = uniqueName("ext-id-max")
      const maxId = 'a'.repeat(64)

      await SandboxInstance.create({ name, externalId: maxId, region: defaultRegion, labels: defaultLabels, image: defaultImage })
      createdSandboxes.push(name)

      const sandbox = await SandboxInstance.getByExternalId(maxId)
      expect(sandbox.metadata.externalId).toBe(maxId)
    })

    it('rejects externalId with invalid characters', async () => {
      const name = uniqueName("ext-id-invalid")
      const invalidId = 'has spaces!'

      await expect(
        SandboxInstance.create({
          name,
          externalId: invalidId,
          region: defaultRegion,
          labels: defaultLabels,
          image: defaultImage,
        })
      ).rejects.toBeDefined()
    })
  })
})
