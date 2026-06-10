import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from './helpers.js'

describe('Sandbox extraArgs (kernel selection)', () => {
  const createdSandboxes: string[] = []
  let nfsSupported = false

  beforeAll(async () => {
    const probeName = uniqueName("extra-args-nfs-probe")
    try {
      await SandboxInstance.create({
        name: probeName,
        image: defaultImage,
        region: defaultRegion,
        extraArgs: { nfs: "enabled" },
        labels: defaultLabels,
      })
      nfsSupported = true
      await SandboxInstance.delete(probeName).catch(() => {})
    } catch {
      nfsSupported = false
    }
  })

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

  it('creates a sandbox with iptables enabled', async () => {
    const name = uniqueName("extra-args-iptables")
    const sandbox = await SandboxInstance.create({
      name,
      image: defaultImage,
      region: defaultRegion,
      extraArgs: { iptables: "enabled" },
      labels: defaultLabels,
    })
    createdSandboxes.push(name)

    const retrieved = await SandboxInstance.get(name)
    expect(retrieved.spec.runtime?.extraArgs).toBeDefined()
    expect(retrieved.spec.runtime?.extraArgs?.["iptables"]).toBe("enabled")
  })

  it('creates a sandbox with nvme enabled', async () => {
    const name = uniqueName("extra-args-nvme")
    const sandbox = await SandboxInstance.create({
      name,
      image: defaultImage,
      region: defaultRegion,
      extraArgs: { nvme: "enabled" },
      labels: defaultLabels,
    })
    createdSandboxes.push(name)

    const retrieved = await SandboxInstance.get(name)
    expect(retrieved.spec.runtime?.extraArgs).toBeDefined()
    expect(retrieved.spec.runtime?.extraArgs?.["nvme"]).toBe("enabled")
  })

  it('creates a sandbox with nfs enabled', async (ctx) => {
    if (!nfsSupported) {
      ctx.skip()
      return
    }
    const name = uniqueName("extra-args-nfs")
    await SandboxInstance.create({
      name,
      image: defaultImage,
      region: defaultRegion,
      extraArgs: { nfs: "enabled" },
      labels: defaultLabels,
    })
    createdSandboxes.push(name)

    const retrieved = await SandboxInstance.get(name)
    expect(retrieved.spec.runtime?.extraArgs).toBeDefined()
    expect(retrieved.spec.runtime?.extraArgs?.["nfs"]).toBe("enabled")
  })

  it('creates a sandbox with both iptables and nvme enabled', async () => {
    const name = uniqueName("extra-args-both")
    const sandbox = await SandboxInstance.create({
      name,
      image: defaultImage,
      region: defaultRegion,
      extraArgs: { iptables: "enabled", nvme: "enabled" },
      labels: defaultLabels,
    })
    createdSandboxes.push(name)

    const retrieved = await SandboxInstance.get(name)
    expect(retrieved.spec.runtime?.extraArgs?.["iptables"]).toBe("enabled")
    expect(retrieved.spec.runtime?.extraArgs?.["nvme"]).toBe("enabled")
  })

  it('creates a sandbox without extraArgs (default kernel)', async () => {
    const name = uniqueName("extra-args-default")
    const sandbox = await SandboxInstance.create({
      name,
      image: defaultImage,
      region: defaultRegion,
      labels: defaultLabels,
    })
    createdSandboxes.push(name)

    const retrieved = await SandboxInstance.get(name)
    // extraArgs should be undefined or empty when not set
    const extraArgs = retrieved.spec.runtime?.extraArgs
    expect(!extraArgs || Object.keys(extraArgs).length === 0).toBe(true)
  })

  it('extraArgs is immutable after creation', async () => {
    const name = uniqueName("extra-args-immutable")
    await SandboxInstance.create({
      name,
      image: defaultImage,
      region: defaultRegion,
      extraArgs: { iptables: "enabled" },
      labels: defaultLabels,
    })
    createdSandboxes.push(name)

    // Update the sandbox metadata (extraArgs should be preserved, not overwritten)
    await SandboxInstance.updateMetadata(name, { labels: { ...defaultLabels, updated: "true" } })

    const retrieved = await SandboxInstance.get(name)
    expect(retrieved.spec.runtime?.extraArgs?.["iptables"]).toBe("enabled")
  })
})
