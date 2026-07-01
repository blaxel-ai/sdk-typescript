import { VolumeInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultLabels, defaultRegion, sleep, uniqueName } from './helpers.js'

describe('Volume Status Lifecycle', { timeout: 180000 }, () => {
  const createdVolumes: string[] = []

  afterAll(async () => {
    await Promise.all(
      createdVolumes.map(async (name) => {
        try {
          await VolumeInstance.delete(name)
        } catch {
          // already gone
        }
      })
    )
  })

  it('transitions through 404 → CREATED/DEPLOYING → DEPLOYED → DELETING → TERMINATED/404', async () => {
    const name = uniqueName("vol-lifecycle")
    const POLL_INTERVAL = 2000
    const DEPLOY_TIMEOUT = 60000
    const TERMINATE_TIMEOUT = 60000

    // 1. GET a volume that doesn't exist → expect 404
    await expect(VolumeInstance.get(name)).rejects.toThrow()

    // 2. Create a volume → expect a provisioning status (CREATED or DEPLOYING)
    const volume = await VolumeInstance.create({
      name,
      size: 1,
      region: defaultRegion,
      labels: defaultLabels,
    })
    createdVolumes.push(name)
    expect(['CREATED', 'DEPLOYING']).toContain(volume.status)

    // 3. Poll GET until DEPLOYED (with timeout)
    const deployDeadline = Date.now() + DEPLOY_TIMEOUT
    let deployed = false
    while (Date.now() < deployDeadline) {
      const vol = await VolumeInstance.get(name)
      if (vol.status === 'DEPLOYED') {
        deployed = true
        break
      }
      await sleep(POLL_INTERVAL)
    }
    expect(deployed).toBe(true)

    // 4. DELETE the volume → expect status = 'DELETING'
    const deleteResponse = await VolumeInstance.delete(name)
    expect(deleteResponse.status).toBe('DELETING')

    // Remove from cleanup list since we already deleted
    const idx = createdVolumes.indexOf(name)
    if (idx !== -1) createdVolumes.splice(idx, 1)

    // 5. Poll GET until TERMINATED or 404
    const terminateDeadline = Date.now() + TERMINATE_TIMEOUT
    let terminated = false
    while (Date.now() < terminateDeadline) {
      try {
        const vol = await VolumeInstance.get(name)
        if (vol.status === 'TERMINATED') {
          terminated = true
          break
        }
      } catch {
        // 404 means volume is fully gone
        terminated = true
        break
      }
      await sleep(POLL_INTERVAL)
    }
    expect(terminated).toBe(true)
  })
})
