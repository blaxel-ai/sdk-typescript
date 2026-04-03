import { SandboxInstance } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from '../helpers.js'
import { proxyCleanup } from './helpers.js'

describe('create with proxy', () => {
  const createdSandboxes: string[] = []
  afterAll(proxyCleanup(createdSandboxes))

  it('creates a sandbox with proxy routing and header injection', async () => {
    const name = uniqueName("proxy-hdr")
    const sandbox = await SandboxInstance.create({
      name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
      network: {
        proxy: {
          routing: [{
            destinations: ["api.stripe.com"],
            headers: { "Authorization": "Bearer {{SECRET:stripe-key}}", "Stripe-Version": "2024-12-18.acacia" },
            secrets: { "stripe-key": "sk-live-test123" },
          }],
        },
      },
    })
    createdSandboxes.push(name)

    expect(sandbox.metadata.name).toBe(name)
    expect(sandbox.spec.network?.proxy).toBeDefined()
    expect(sandbox.spec.network?.proxy?.routing).toHaveLength(1)
    expect(sandbox.spec.network?.proxy?.routing?.[0]?.destinations).toContain("api.stripe.com")
    expect(sandbox.spec.network?.proxy?.routing?.[0]?.headers?.["Authorization"]).toBe("Bearer {{SECRET:stripe-key}}")
    expect(sandbox.spec.network?.proxy?.routing?.[0]?.headers?.["Stripe-Version"]).toBe("2024-12-18.acacia")
    expect(sandbox.spec.network?.proxy?.routing?.[0]?.secrets).toEqual({ "stripe-key": "sk-live-test123" })
  })

  it('creates a sandbox with proxy body injection', async () => {
    const name = uniqueName("proxy-body")
    const sandbox = await SandboxInstance.create({
      name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
      network: {
        proxy: {
          routing: [{
            destinations: ["api.stripe.com"],
            headers: { "Authorization": "Bearer {{SECRET:stripe-key}}" },
            body: { "api_key": "{{SECRET:stripe-key}}" },
            secrets: { "stripe-key": "sk-live-test123" },
          }],
        },
      },
    })
    createdSandboxes.push(name)

    const route = sandbox.spec.network?.proxy?.routing?.[0]
    expect(route?.body).toBeDefined()
    expect(route?.body?.["api_key"]).toBe("{{SECRET:stripe-key}}")
  })

  it('creates a sandbox with multiple proxy routing rules', async () => {
    const name = uniqueName("proxy-multi")
    const sandbox = await SandboxInstance.create({
      name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
      network: {
        proxy: {
          routing: [
            {
              destinations: ["api.stripe.com"],
              headers: { "Authorization": "Bearer {{SECRET:stripe-key}}", "Stripe-Version": "2024-12-18.acacia", "X-Request-Source": "blaxel-sandbox" },
              body: { "api_key": "{{SECRET:stripe-key}}" },
              secrets: { "stripe-key": "sk-live-test123" },
            },
            {
              destinations: ["api.openai.com"],
              headers: { "Authorization": "Bearer {{SECRET:openai-key}}", "OpenAI-Organization": "org-abc123" },
              secrets: { "openai-key": "sk-proj-test789" },
            },
          ],
          bypass: ["*.s3.amazonaws.com"],
        },
      },
    })
    createdSandboxes.push(name)

    const proxyConfig = sandbox.spec.network?.proxy
    expect(proxyConfig?.routing).toHaveLength(2)

    const stripeRoute = proxyConfig?.routing?.find(r => r.destinations?.includes("api.stripe.com"))
    expect(stripeRoute).toBeDefined()
    expect(stripeRoute?.headers?.["X-Request-Source"]).toBe("blaxel-sandbox")
    expect(stripeRoute?.body?.["api_key"]).toBe("{{SECRET:stripe-key}}")
    expect(stripeRoute?.secrets).toEqual({ "stripe-key": "sk-live-test123" })

    const openaiRoute = proxyConfig?.routing?.find(r => r.destinations?.includes("api.openai.com"))
    expect(openaiRoute).toBeDefined()
    expect(openaiRoute?.headers?.["OpenAI-Organization"]).toBe("org-abc123")
    expect(openaiRoute?.secrets).toEqual({ "openai-key": "sk-proj-test789" })

    expect(proxyConfig?.bypass).toContain("*.s3.amazonaws.com")
  })

  it('creates a sandbox with proxy bypass only', async () => {
    const name = uniqueName("proxy-bypass")
    const sandbox = await SandboxInstance.create({
      name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
      network: { proxy: { bypass: ["*.s3.amazonaws.com", "169.254.169.254"] } },
    })
    createdSandboxes.push(name)

    expect(sandbox.spec.network?.proxy?.bypass).toEqual(["*.s3.amazonaws.com", "169.254.169.254"])
    expect(sandbox.spec.network?.proxy?.routing).toBeUndefined()
  })

  it('creates a sandbox with proxy and allowedDomains combined', async () => {
    const name = uniqueName("proxy-fw")
    const sandbox = await SandboxInstance.create({
      name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
      network: {
        allowedDomains: ["api.stripe.com", "api.openai.com", "*.s3.amazonaws.com"],
        proxy: {
          routing: [{ destinations: ["api.stripe.com"], headers: { "Authorization": "Bearer {{SECRET:stripe-key}}" }, secrets: { "stripe-key": "sk-live-test123" } }],
          bypass: ["*.s3.amazonaws.com"],
        },
      },
    })
    createdSandboxes.push(name)

    const net = sandbox.spec.network
    expect(net?.allowedDomains ?? net?.proxy?.routing).toBeDefined()
    expect(net?.proxy?.routing).toHaveLength(1)
    expect(net?.proxy?.bypass).toContain("*.s3.amazonaws.com")
  })
})
