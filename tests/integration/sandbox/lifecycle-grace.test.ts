import { SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from './helpers.js'

describe('Sandbox lifecycle grace periods', () => {
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

  it('creates a sandbox with termination and standby grace periods', async () => {
    const name = uniqueName("lifecycle-grace")
    await SandboxInstance.create({
      name,
      image: defaultImage,
      region: defaultRegion,
      terminationGracePeriodSeconds: 30,
      standbyGracePeriodSeconds: 30,
      labels: defaultLabels,
    })
    createdSandboxes.push(name)

    const retrieved = await SandboxInstance.get(name)
    expect(retrieved.spec.runtime?.terminationGracePeriodSeconds).toBe(30)
    expect(retrieved.spec.runtime?.standbyGracePeriodSeconds).toBe(30)
  })

  it('rejects a standby grace period above the limit', async () => {
    const name = uniqueName("lifecycle-grace-too-long")
    await expect(SandboxInstance.create({
      name,
      image: defaultImage,
      region: defaultRegion,
      standbyGracePeriodSeconds: 301,
      labels: defaultLabels,
    })).rejects.toThrow(/standbyGracePeriodSeconds/)
  })
})
