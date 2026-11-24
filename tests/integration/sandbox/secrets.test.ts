/**
 * Integration test for workspace (proxy) secrets: write-only values scoped to
 * `destinations`, delivered to every region's proxy asynchronously.
 *
 * Requires: BL_WORKSPACE, BL_API_KEY
 *
 * @vitest-environment node
 */

import { afterAll, describe, expect, it } from 'vitest'
import { listSecrets, SecretInstance, upsertSecret } from "@blaxel/core"
import { uniqueName } from './helpers.js'

// Workspace secrets are behind the "workspace-secrets" feature flag (403 when off,
// 404 on environments without the secrets API): skip unless the workspace has them.
const { response: probe } = await listSecrets()
const secretsEnabled = probe.status !== 403 && probe.status !== 404

function byName(secrets: SecretInstance[], name: string): SecretInstance[] {
  return secrets.filter((s) => s.name === name)
}

// A deleted secret stays listed as DELETING until every region removed it.
function gone(secrets: SecretInstance[], name: string): boolean {
  return byName(secrets, name).every((s) => s.status === 'DELETING')
}

describe.skipIf(!secretsEnabled)('Workspace secrets', () => {
  const created: string[] = []

  afterAll(async () => {
    await Promise.all(created.map((name) => SecretInstance.delete(name).catch(() => undefined)))
  })

  it('sets, lists, rotates and deletes a secret with its destinations', async () => {
    const name = uniqueName('sdk-secret')
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
    expect(gone(await SecretInstance.list(), name)).toBe(true)
  })

  it('fails to delete a secret that never existed', async () => {
    await expect(SecretInstance.delete(uniqueName('sdk-secret-missing'))).rejects.toThrow()
  })

  it('rejects a secret without destinations', async () => {
    const { response } = await upsertSecret({
      body: { name: uniqueName('sdk-secret-nodest'), value: 'value', destinations: [] },
    })
    expect(response.status).toBe(400)
  })

  it('rejects a bare wildcard destination', async () => {
    await expect(SecretInstance.set(uniqueName('sdk-secret-wild'), 'value', ['*'])).rejects.toThrow()
  })
})
