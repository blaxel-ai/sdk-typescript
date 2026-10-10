import { SandboxInstance } from "@blaxel/core"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from "./helpers.js"

// createIfNotExists returns the sandbox already holding the name, whatever it
// was created with. When that sandbox is not what the call asked for, the SDK
// says so with one warning; what the call returns does not change.
describe("createIfNotExists drift warning", () => {
  const name = uniqueName("drift")
  const otherRegion = defaultRegion === "us-pdx-1" ? "us-was-1" : "us-pdx-1"
  const config = {
    name,
    image: defaultImage,
    memory: 2048,
    region: defaultRegion,
    labels: defaultLabels,
    envs: [{ name: "KEEP", value: "same" }],
  }
  let created: SandboxInstance
  let warnings: string[] = []

  const driftWarnings = () => warnings.filter((message) => message.includes("already exists"))
  const captureWarnings = () => {
    warnings = []
    vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
      warnings.push(String(message))
    })
  }

  beforeAll(async () => {
    created = await SandboxInstance.create(config)
  }, 60_000)

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    try {
      await SandboxInstance.delete(name)
    } catch {
      // best-effort cleanup
    }
  })

  it("stays quiet when the request matches the existing sandbox", async () => {
    captureWarnings()
    const again = await SandboxInstance.createIfNotExists(config)
    expect(again.metadata.createdAt).toBe(created.metadata.createdAt)
    expect(driftWarnings()).toEqual([])
  }, 60_000)

  it("warns once with the differing fields and returns the existing sandbox unchanged", async () => {
    captureWarnings()
    const again = await SandboxInstance.createIfNotExists({
      ...config,
      image: "blaxel/node:latest",
      memory: 4096,
      region: otherRegion,
      envs: [...config.envs, { name: "ADDED", value: "never-logged" }],
    })

    // Nothing was applied: same sandbox, same configuration.
    expect(again.metadata.createdAt).toBe(created.metadata.createdAt)
    expect(again.spec.runtime?.image).toBe(defaultImage)
    expect(again.spec.runtime?.memory).toBe(2048)
    expect(again.spec.region).toBe(defaultRegion)

    const [message, ...rest] = driftWarnings()
    expect(rest).toEqual([])
    expect(message).toContain(`sandbox "${name}" already exists`)
    expect(message).toContain(`image (requested blaxel/node:latest, existing ${defaultImage})`)
    expect(message).toContain("memory (requested 4096 MB, existing 2048 MB)")
    expect(message).toContain(`region (requested ${otherRegion}, existing ${defaultRegion})`)
    expect(message).toContain("envs (not set on the existing sandbox: ADDED)")
    expect(message).not.toContain("never-logged")
  }, 60_000)
})
