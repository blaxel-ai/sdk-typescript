import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from '../helpers.js'
import { lowercaseKeys, parseJsonOutput, proxyCleanup, proxyHelperScript } from './helpers.js'

describe('proxy with wildcard (*) destination', () => {
  const createdSandboxes: string[] = []
  afterAll(proxyCleanup(createdSandboxes))

  let wildcardSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

  beforeAll(async () => {
    const name = uniqueName("proxy-wild")
    wildcardSandbox = await SandboxInstance.create({
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
    createdSandboxes.push(name)
    await wildcardSandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
  }, 60_000)

  it('applies global rule to httpbin.org', async () => {
    const result = await wildcardSandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers', waitForCompletion: true })
    expect(result.exitCode).toBe(0)
    const headers = lowercaseKeys(parseJsonOutput(result.logs).headers)
    expect(headers["x-global-auth"]).toBe("Bearer global-token-xyz")
  }, 60_000)
})
