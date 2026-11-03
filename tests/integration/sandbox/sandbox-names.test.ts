import { isValidSandboxName, sanitizeSandboxName, SandboxInstance } from "@blaxel/core"
import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion } from './helpers.js'

// The API accepts a sandbox name only when it is lowercase letters and digits
// separated by single hyphens. The SDK sends the name as given; callers that
// name sandboxes after their own ids pass them through sanitizeSandboxName.
describe("Sandbox names", () => {
  const created: string[] = []

  afterAll(async () => {
    await Promise.all(created.map((name) => SandboxInstance.delete(name).catch(() => { })))
  })

  it("creates a sandbox named after a sanitized external id", async () => {
    const externalId = `Sesn_${randomUUID().slice(0, 8).toUpperCase()}`
    const name = sanitizeSandboxName(externalId)
    expect(isValidSandboxName(name)).toBe(true)
    created.push(name)

    const sandbox = await SandboxInstance.create({ name, image: defaultImage, memory: 2048, region: defaultRegion, labels: defaultLabels })

    expect(sandbox.metadata.name).toBe(name)
  }, 60_000)

  it("rejects an invalid name with the name to use instead", async () => {
    const externalId = `sesn_${randomUUID().slice(0, 8)}`
    expect(isValidSandboxName(externalId)).toBe(false)
    created.push(externalId)

    const error = await SandboxInstance.create({ name: externalId, image: defaultImage, memory: 2048, region: defaultRegion, labels: defaultLabels })
      .catch((e: unknown) => e)

    expect(error).toHaveProperty("message")
    expect((error as { message: string }).message).toContain(sanitizeSandboxName(externalId))
  })
})
