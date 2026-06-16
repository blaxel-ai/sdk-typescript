import { SandboxInstance, settings } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName, waitForSandboxDeletion, sleep } from './helpers.js'

/**
 * Helper: raw fetch against the controlplane API with SDK auth headers.
 * Used because the generated SDK types don't include externalId yet.
 */
async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${settings.baseUrl}${path}`
  return fetch(url, {
    ...init,
    headers: {
      ...settings.headers,
      ...(init?.headers || {}),
    },
  })
}

/**
 * Creates a sandbox with an externalId by issuing a raw POST (the generated
 * SDK doesn't know about the field yet).
 */
async function createSandboxWithExternalId(name: string, externalId: string) {
  const body = {
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
  }
  const res = await apiFetch('/sandboxes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`createSandboxWithExternalId failed (${res.status}): ${text}`)
  }
  return res.json()
}

/**
 * Updates a sandbox's externalId via PUT (preserves other fields).
 */
async function updateSandboxExternalId(name: string, externalId: string) {
  // First get the current sandbox
  const getRes = await apiFetch(`/sandboxes/${name}`)
  if (!getRes.ok) throw new Error(`GET /sandboxes/${name} failed: ${getRes.status}`)
  const sandbox = await getRes.json()

  // Update metadata.externalId
  sandbox.metadata.externalId = externalId

  const res = await apiFetch(`/sandboxes/${name}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sandbox),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`updateSandboxExternalId failed (${res.status}): ${text}`)
  }
  return res.json()
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
      const res = await apiFetch(`/sandboxes/${name}`)
      expect(res.ok).toBe(true)
      const sandbox = await res.json()
      expect(sandbox.metadata.externalId).toBe(externalId)
    })

    it('creates a sandbox without externalId (optional field)', async () => {
      const name = uniqueName("ext-id-none")
      await SandboxInstance.create({ name, region: defaultRegion, labels: defaultLabels })
      createdSandboxes.push(name)

      const res = await apiFetch(`/sandboxes/${name}`)
      expect(res.ok).toBe(true)
      const sandbox = await res.json()
      // externalId should be empty or not set
      expect(sandbox.metadata.externalId || "").toBe("")
    })
  })

  describe('GET /sandboxes/by-external-id/{externalId}', () => {
    it('returns the sandbox by externalId', async () => {
      const name = uniqueName("ext-id-get")
      const externalId = `get-${Date.now()}`

      await createSandboxWithExternalId(name, externalId)
      createdSandboxes.push(name)

      const res = await apiFetch(`/sandboxes/by-external-id/${externalId}`)
      expect(res.ok).toBe(true)
      const sandbox = await res.json()
      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.metadata.externalId).toBe(externalId)
    })

    it('returns 404 for non-existent externalId', async () => {
      const res = await apiFetch(`/sandboxes/by-external-id/does-not-exist-${Date.now()}`)
      expect(res.status).toBe(404)
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
      const res = await apiFetch(`/sandboxes/by-external-id/${externalId}`)
      expect(res.ok).toBe(true)
      const sandbox = await res.json()
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
      const res = await apiFetch(`/sandboxes/by-external-id/${externalId}`)
      expect(res.status).toBe(404)
    })
  })

  describe('GET /sandboxes?externalId=...', () => {
    it('filters sandboxes by externalId query param', async () => {
      const name = uniqueName("ext-id-filter")
      const externalId = `filter-${Date.now()}`

      await createSandboxWithExternalId(name, externalId)
      createdSandboxes.push(name)

      const res = await apiFetch(`/sandboxes?externalId=${externalId}`)
      expect(res.ok).toBe(true)
      const sandboxes = await res.json()
      expect(Array.isArray(sandboxes)).toBe(true)
      expect(sandboxes.length).toBeGreaterThanOrEqual(1)

      const found = sandboxes.find((s: any) => s.metadata.name === name)
      expect(found).toBeDefined()
      expect(found.metadata.externalId).toBe(externalId)
    })

    it('returns empty list for non-existent externalId', async () => {
      const res = await apiFetch(`/sandboxes?externalId=nonexistent-${Date.now()}`)
      expect(res.ok).toBe(true)
      const sandboxes = await res.json()
      expect(Array.isArray(sandboxes)).toBe(true)
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
      const res = await apiFetch(`/sandboxes?externalId=${externalId}`)
      expect(res.ok).toBe(true)
      const sandboxes = await res.json()
      const found = sandboxes.find((s: any) => s.metadata.name === name)
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
      const resOld = await apiFetch(`/sandboxes/by-external-id/${externalId1}`)
      expect(resOld.status).toBe(404)

      // New externalId should work
      const resNew = await apiFetch(`/sandboxes/by-external-id/${externalId2}`)
      expect(resNew.ok).toBe(true)
      const sandbox = await resNew.json()
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
      const res = await apiFetch(`/sandboxes/by-external-id/${externalId}`)
      expect(res.ok).toBe(true)
      const sandbox = await res.json()
      expect(sandbox.metadata.name).toBe(name)
      expect(sandbox.metadata.externalId).toBe(externalId)
    })
  })

  describe('validation', () => {
    it('rejects externalId longer than 64 characters', async () => {
      const name = uniqueName("ext-id-toolong")
      const longId = 'a'.repeat(65)

      const res = await apiFetch('/sandboxes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metadata: { name, labels: defaultLabels, externalId: longId },
          spec: { runtime: { image: defaultImage }, region: defaultRegion },
        }),
      })

      // Should fail validation
      if (res.ok) {
        // If it somehow passed, clean up
        createdSandboxes.push(name)
      }
      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)
    })

    it('accepts externalId at exactly 64 characters', async () => {
      const name = uniqueName("ext-id-max")
      const maxId = 'a'.repeat(64)

      await createSandboxWithExternalId(name, maxId)
      createdSandboxes.push(name)

      const res = await apiFetch(`/sandboxes/by-external-id/${maxId}`)
      expect(res.ok).toBe(true)
      const sandbox = await res.json()
      expect(sandbox.metadata.externalId).toBe(maxId)
    })

    it('rejects externalId with invalid characters', async () => {
      const name = uniqueName("ext-id-invalid")
      const invalidId = 'has spaces!'

      const res = await apiFetch('/sandboxes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metadata: { name, labels: defaultLabels, externalId: invalidId },
          spec: { runtime: { image: defaultImage }, region: defaultRegion },
        }),
      })

      if (res.ok) {
        createdSandboxes.push(name)
      }
      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)
    })
  })
})
