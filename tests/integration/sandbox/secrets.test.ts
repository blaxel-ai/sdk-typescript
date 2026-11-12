/**
 * Integration test for workspace (proxy) secrets: write-only values scoped to
 * `destinations`, versioned on the backend.
 *
 * Requires: BL_WORKSPACE, BL_API_KEY
 *
 * @vitest-environment node
 */

import { afterAll, describe, expect, it } from 'vitest'
import { SecretInstance, deleteSecret, upsertSecret } from "@blaxel/core"
import { uniqueName } from './helpers.js'

// Workspace secrets are behind the "workspace-secrets" feature flag (403 when off, 404 on
// environments that predate controlplane#5736), and environments that predate controlplane#5802
// accept but silently drop `destinations`. Probe with a throwaway secret and skip unless the
// API echoes the destinations back.
async function destinationsSupported(): Promise<boolean> {
  const name = uniqueName('sdk-test-secret-probe')
  const { response, data } = await upsertSecret({ body: { name, value: 'probe', destinations: ['api.stripe.com'] } })
  if (!response.ok) return false
  await deleteSecret({ path: { secretName: name } }).catch(() => undefined)
  return Array.isArray(data?.destinations)
}
const secretsEnabled = await destinationsSupported()

function byName(secrets: SecretInstance[], name: string): SecretInstance[] {
  return secrets.filter((s) => s.name === name)
}

describe.skipIf(!secretsEnabled)('Workspace secrets', () => {
  const created: string[] = []

  afterAll(async () => {
    await Promise.all(created.map((name) => SecretInstance.delete(name).catch(() => undefined)))
  })

  it('sets, lists, rotates and deletes a secret with its destinations', async () => {
    const name = uniqueName('sdk-test-secret')
    created.push(name)

    const secret = await SecretInstance.set(name, 'first-value', ['api.stripe.com'])
    expect(secret.name).toBe(name)
    expect(secret.destinations).toEqual(['api.stripe.com'])
    expect((secret as unknown as { secret: Record<string, unknown> }).secret).not.toHaveProperty('value')

    const listed = byName(await SecretInstance.list(), name)
    expect(listed).toHaveLength(1)
    expect(listed[0].destinations).toEqual(['api.stripe.com'])
    expect(listed[0].createdAt).toBeDefined()
    expect(listed[0].updatedAt).toBeDefined()
    expect((listed[0] as unknown as { secret: Record<string, unknown> }).secret).not.toHaveProperty('value')

    const rotated = await SecretInstance.set(name, 'second-value', ['api.stripe.com', 'api.example.com/v1/*'])
    expect(rotated.destinations).toEqual(['api.stripe.com', 'api.example.com/v1/*'])
    const listedRotated = byName(await SecretInstance.list(), name)
    expect(listedRotated).toHaveLength(1)
    expect(listedRotated[0].destinations).toEqual(['api.stripe.com', 'api.example.com/v1/*'])
    expect(listedRotated[0].createdAt).toBe(listed[0].createdAt)

    const deleted = await SecretInstance.delete(name)
    expect(deleted.name).toBe(name)
    created.splice(created.indexOf(name), 1)
    expect(byName(await SecretInstance.list(), name)).toEqual([])
  })

  it('deleting an unknown secret is a no-op', async () => {
    await expect(SecretInstance.delete(uniqueName('sdk-test-secret-missing'))).resolves.toBeDefined()
  })

  it('rejects a secret without destinations', async () => {
    const { response } = await upsertSecret({
      body: { name: uniqueName('sdk-test-secret-nodest'), value: 'value', destinations: [] },
    })
    expect(response.status).toBe(400)
  })

  it('rejects a bare wildcard destination', async () => {
    const { response } = await upsertSecret({
      body: { name: uniqueName('sdk-test-secret-wild'), value: 'value', destinations: ['*'] },
    })
    expect(response.status).toBe(400)
  })
})
