import { SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName, waitForSandboxDeletion } from '../helpers.js'
import { proxyCleanup } from './helpers.js'

describe('get proxy config', () => {
  const createdSandboxes: string[] = []
  afterAll(proxyCleanup(createdSandboxes))

  it('retrieves sandbox with proxy and validates config if returned', async () => {
    const name = uniqueName("proxy-get")
    await SandboxInstance.create({
      name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
      network: {
        proxy: {
          routing: [{
            destinations: ["api.openai.com"],
            headers: { "Authorization": "Bearer {{SECRET:openai-key}}", "OpenAI-Organization": "org-abc123" },
            secrets: { "openai-key": "sk-proj-test789" },
          }],
          bypass: ["169.254.169.254"],
        },
      },
    })
    createdSandboxes.push(name)

    const retrieved = await SandboxInstance.get(name)
    expect(retrieved.spec.network).toBeDefined()
    const proxy = retrieved.spec.network?.proxy
    if (proxy) {
      expect(proxy.routing).toHaveLength(1)
      expect(proxy.routing?.[0]?.destinations).toContain("api.openai.com")
      expect(proxy.routing?.[0]?.headers?.["Authorization"]).toBe("Bearer {{SECRET:openai-key}}")
      expect(proxy.routing?.[0]?.headers?.["OpenAI-Organization"]).toBe("org-abc123")
      expect(proxy.bypass).toContain("169.254.169.254")
      expect(proxy.routing?.[0]?.secrets).toBeUndefined()
    }
  })

  it('returns no proxy config when sandbox has none', async () => {
    const name = uniqueName("proxy-none")
    await SandboxInstance.create({ name, image: defaultImage, region: defaultRegion, labels: defaultLabels })
    createdSandboxes.push(name)

    const retrieved = await SandboxInstance.get(name)
    expect(retrieved.spec.network?.proxy).toBeUndefined()
  })
})

describe('delete sandbox with proxy', () => {
  it('deletes a sandbox that has proxy configuration', async () => {
    const name = uniqueName("proxy-del")
    await SandboxInstance.create({
      name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
      network: {
        proxy: {
          routing: [{ destinations: ["api.stripe.com"], headers: { "Authorization": "Bearer {{SECRET:stripe-key}}" }, secrets: { "stripe-key": "sk-live-test123" } }],
        },
      },
    })

    await SandboxInstance.delete(name)
    const deleted = await waitForSandboxDeletion(name)
    expect(deleted).toBe(true)
  })
})
