import { DriveInstance, SandboxDriveSetupError, SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, uniqueName, waitForSandboxDeletion } from './helpers.js'

const region = 'us-was-1' // Drives are only available in some regions

describe('Sandbox create with mountDrives', () => {
  const sandboxes: string[] = []
  const drives: string[] = []
  const config = () => ({ image: defaultImage, region, labels: defaultLabels })

  afterAll(async () => {
    await Promise.all(sandboxes.map(async (name) => {
      try {
        await SandboxInstance.delete(name)
        await waitForSandboxDeletion(name)
      } catch { /* ignore */ }
    }))
    await Promise.all(drives.map(name => DriveInstance.delete(name).catch(() => { })))
  })

  it('mounts a new drive, shares it, reuses it, and keeps the sandbox on a region mismatch', async () => {
    // A new drive with a generated name, usable straight away.
    const first = await SandboxInstance.create(config(), {
      mountDrives: [{ create: { labels: defaultLabels }, mountPath: '/mnt/data' }],
    })
    sandboxes.push(first.metadata.name)
    const [mount] = await first.drives.list()
    const driveName = mount.driveName!
    drives.push(driveName)
    await first.fs.write('/mnt/data/hello.txt', 'hello')

    // The same drive, by name, in a second sandbox.
    const second = await SandboxInstance.create(config(), {
      mountDrives: [{ driveName, mountPath: '/mnt/shared' }],
    })
    sandboxes.push(second.metadata.name)
    expect(await second.fs.read('/mnt/shared/hello.txt')).toBe('hello')

    // createIfNotExists on an existing sandbox that already has the mount.
    const reused = await SandboxInstance.createIfNotExists({ name: first.metadata.name, region }, {
      mountDrives: [{ driveName, mountPath: '/mnt/data' }],
    })
    expect(reused.metadata.name).toBe(first.metadata.name)

    // A drive in another region is rejected; the sandbox stays.
    const otherRegion = await SandboxInstance.create({ ...config(), region: 'eu-lon-1' }, {
      mountDrives: [{ driveName, mountPath: '/mnt/data' }],
    }).catch((error: unknown) => error)
    expect(otherRegion).toBeInstanceOf(SandboxDriveSetupError)
    const { sandbox, driveNames } = otherRegion as SandboxDriveSetupError
    sandboxes.push(sandbox.metadata.name)
    expect(driveNames).toEqual([driveName])
    expect((await SandboxInstance.get(sandbox.metadata.name)).status).not.toBe('TERMINATED')
  }, 55000)

  it('rejects a missing drive without creating it', async () => {
    const missing = uniqueName('missing-drive')
    const error = await SandboxInstance.create(config(), {
      mountDrives: [{ driveName: missing, mountPath: '/mnt/data' }],
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SandboxDriveSetupError)
    sandboxes.push((error as SandboxDriveSetupError).sandbox.metadata.name)
    expect((error as Error).message).toContain('Drive not found')
    await expect(DriveInstance.get(missing)).rejects.toMatchObject({ code: 404 })
  }, 30000)
})
