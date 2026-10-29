import { SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultLabels, defaultRegion, isSlowTestEnabled, uniqueName } from './helpers.js'

// Needs a private registry image and credentials that can pull it, e.g.
// PRIVATE_REGISTRY_IMAGE=ghcr.io/org/private:v1
// PRIVATE_REGISTRY_DOCKER_CONFIG='{"auths":{"ghcr.io":{"auth":"<base64 user:token>"}}}'
// The registry import can take minutes, so the suite also needs RUN_SLOW_PRIVATE_REGISTRY=true.
const image = process.env.PRIVATE_REGISTRY_IMAGE
const dockerConfig = process.env.PRIVATE_REGISTRY_DOCKER_CONFIG

async function waitForTerminalStatus(name: string): Promise<string | undefined> {
  const deadline = Date.now() + 10 * 60_000
  let status: string | undefined
  while (Date.now() < deadline) {
    status = (await SandboxInstance.get(name)).status
    if (status === "DEPLOYED" || status === "FAILED") return status
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  return status
}

describe.runIf(isSlowTestEnabled("RUN_SLOW_PRIVATE_REGISTRY") && image && dockerConfig)('Sandbox from a private registry image', () => {
  const createdSandboxes: string[] = []

  afterAll(async () => {
    await Promise.all(createdSandboxes.map((name) => SandboxInstance.delete(name).catch(() => {})))
  })

  it('pulls the image with dockerConfig', async () => {
    const name = uniqueName("private-registry")
    await SandboxInstance.create({ name, image, region: defaultRegion, dockerConfig, labels: defaultLabels })
    createdSandboxes.push(name)

    expect(await waitForTerminalStatus(name)).toBe("DEPLOYED")
    const sandbox = await SandboxInstance.get(name)
    const result = await sandbox.process.exec({ command: "echo pulled", waitForCompletion: true })
    expect(result.logs?.trim()).toBe("pulled")
  }, 11 * 60_000)

  it('fails without dockerConfig', async () => {
    const name = uniqueName("private-registry-nocreds")
    await SandboxInstance.create({ name, image, region: defaultRegion, labels: defaultLabels })
    createdSandboxes.push(name)

    expect(await waitForTerminalStatus(name)).toBe("FAILED")
  }, 11 * 60_000)
})
