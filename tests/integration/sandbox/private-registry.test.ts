import { SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultLabels, defaultRegion, uniqueName } from './helpers.js'

// Needs a private registry image and credentials that can pull it, e.g.
// PRIVATE_REGISTRY_IMAGE=ghcr.io/org/private:v1
// PRIVATE_REGISTRY_DOCKER_CONFIG='{"auths":{"ghcr.io":{"auth":"<base64 user:token>"}}}'
// The registry import takes minutes, so the suite only runs when both are set.
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

describe.runIf(image && dockerConfig)('Sandbox from a private registry image', () => {
  const createdSandboxes: string[] = []

  afterAll(async () => {
    await Promise.all(createdSandboxes.map((name) => SandboxInstance.delete(name).catch(() => {})))
  })

  it('pulls the image with dockerConfig', async () => {
    const name = uniqueName("private-registry")
    await SandboxInstance.create({ name, image, region: defaultRegion, dockerConfig, labels: defaultLabels })
    createdSandboxes.push(name)

    expect(await waitForTerminalStatus(name)).toBe("DEPLOYED")
  }, 11 * 60_000)

  it('fails without dockerConfig', async () => {
    const name = uniqueName("private-registry-nocreds")
    await SandboxInstance.create({ name, image, region: defaultRegion, labels: defaultLabels })
    createdSandboxes.push(name)

    expect(await waitForTerminalStatus(name)).toBe("FAILED")
  }, 11 * 60_000)
})
