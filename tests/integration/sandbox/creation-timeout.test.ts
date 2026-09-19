import { MAX_CREATION_TIMEOUT_SECONDS, SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from './helpers.js'

describe("Sandbox creation timeout option", () => {
  const created: string[] = []

  afterAll(async () => {
    await Promise.all(created.map((name) => SandboxInstance.delete(name).catch(() => { })))
  })

  it("creates a sandbox with a per-request creation timeout", async () => {
    const name = uniqueName("create-timeout")
    created.push(name)
    const sandbox = await SandboxInstance.create(
      { name, image: defaultImage, memory: 2048, region: defaultRegion, labels: defaultLabels },
      { timeout: MAX_CREATION_TIMEOUT_SECONDS, retry: 1 },
    )
    expect(sandbox.metadata.name).toBe(name)
    expect(sandbox.status).toBe("DEPLOYED")
    const result = await sandbox.process.exec({ command: "echo ok", waitForCompletion: true })
    expect(result.logs?.trim()).toBe("ok")
  }, 60_000)

  it("rejects a creation timeout above the cap before calling the API", async () => {
    await expect(
      SandboxInstance.create(
        { name: uniqueName("create-timeout-cap"), image: defaultImage, memory: 2048, region: defaultRegion, labels: defaultLabels },
        { timeout: MAX_CREATION_TIMEOUT_SECONDS + 1 },
      ),
    ).rejects.toThrow(/between 1 and 50/)
  })
})
