import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from '../helpers.js'
import { createEchoServerSandbox, createReadyProxySandbox, execProxyCommandWithRetry, lowercaseKeys, parseJsonObjectOutput, proxyCleanup } from './helpers.js'

type HttpBinResponse = {
  headers: Record<string, string>
}

describe('proxy with wildcard (*) destination', () => {
  const createdSandboxes: string[] = []
  afterAll(proxyCleanup(createdSandboxes))

  let wildcardSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>
  // Controlled httpbin-compatible upstream reached via a preview URL.
  let headersUrl: string

  beforeAll(async () => {
    const echo = await createEchoServerSandbox(createdSandboxes)
    headersUrl = `${echo.url}/headers`

    wildcardSandbox = await createReadyProxySandbox(
      async () => {
        const name = uniqueName("proxy-wild")
        const sandbox = await SandboxInstance.create({
          name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
          network: {
            proxy: {
              routing: [{
                destinations: ["*"],
                headers: { "X-Global-Auth": "Bearer {{SECRET:global-key}}" },
                secrets: { "global-key": "global-token-xyz" },
              }],
            },
          },
        })
        return { name, sandbox }
      },
      createdSandboxes,
      `node /tmp/proxy-test.js GET ${headersUrl}`,
      (result) => {
        if (result.exitCode !== 0) return false
        const headers = lowercaseKeys(parseJsonObjectOutput<HttpBinResponse>(result.logs).headers)
        return headers["x-global-auth"] === "Bearer global-token-xyz"
      },
    )
  }, 180_000)

  it('applies global rule to any destination', async () => {
    const result = await execProxyCommandWithRetry(wildcardSandbox, `node /tmp/proxy-test.js GET ${headersUrl}`)
    expect(result.exitCode, result.logs).toBe(0)
    const headers = lowercaseKeys(parseJsonObjectOutput<HttpBinResponse>(result.logs).headers)
    expect(headers["x-global-auth"]).toBe("Bearer global-token-xyz")
  }, 60_000)
})
