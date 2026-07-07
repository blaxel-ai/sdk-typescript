import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName, isUsingMk3_1 } from '../helpers.js'
import { createEchoServerSandbox, createReadyProxySandbox, execProxyCommandWithRetry, lowercaseKeys, parseJsonObjectOutput, proxyCleanup } from './helpers.js'

type HttpBinResponse = {
  headers: Record<string, string>
}

describe.skipIf(isUsingMk3_1())('firewall e2e (allowedDomains / forbiddenDomains)', () => {
  const createdSandboxes: string[] = []
  afterAll(proxyCleanup(createdSandboxes))

  // A single controlled httpbin-compatible upstream (reached via a preview URL)
  // shared by every nested suite, replacing the flaky public httpbin.org. We use
  // its hostname as the allowlisted domain and `example.com` as the blocked one.
  let echoHost: string
  let echoUrl: string

  beforeAll(async () => {
    const echo = await createEchoServerSandbox(createdSandboxes)
    echoHost = echo.host
    echoUrl = echo.url
  }, 180_000)

  let fwSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

  describe.skipIf(isUsingMk3_1())('allowedDomains (allowlist)', () => {
    beforeAll(async () => {
      fwSandbox = await createReadyProxySandbox(
        async () => {
          const name = uniqueName("fw-allow")
          const sandbox = await SandboxInstance.create({
            name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
            network: { allowedDomains: [echoHost], proxy: { routing: [] } },
          })
          return { name, sandbox }
        },
        createdSandboxes,
        `node /tmp/proxy-test.js GET ${echoUrl}/get`,
      )
    }, 180_000)

    it('allows requests to allowlisted domain', async () => {
      const result = await execProxyCommandWithRetry(fwSandbox, `node /tmp/proxy-test.js GET ${echoUrl}/get`)
      expect(result.exitCode, result.logs).toBe(0)
      expect(result.logs).toContain(echoHost)
    }, 60_000)

    it('blocks requests to non-allowlisted domain', async () => {
      const result = await fwSandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://example.com', waitForCompletion: true })
      expect(result.exitCode).not.toBe(0)
    }, 60_000)
  })

  describe.skipIf(isUsingMk3_1())('no proxy bypass (firewall ruleset: proxy)', () => {
    let bypassSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

    beforeAll(async () => {
      const readyStart = Date.now()
      bypassSandbox = await createReadyProxySandbox(
        async () => {
          const name = uniqueName("fw-bypass")
          console.log(`[fw-bypass] creating sandbox ${name}...`)
          const createStart = Date.now()
          const sandbox = await SandboxInstance.create({
            name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
            network: {
              firewall: { rulesets: ["proxy"] },
              allowedDomains: [echoHost],
              proxy: { routing: [] },
            },
          })
          console.log(`[fw-bypass] SandboxInstance.create took ${Date.now() - createStart}ms`)
          return { name, sandbox }
        },
        createdSandboxes,
        `node /tmp/proxy-test.js GET ${echoUrl}/get`,
      )
      console.log(`[fw-bypass] sandbox ready (create + proxy warmup) took ${Date.now() - readyStart}ms`)

      // // Give the "proxy" firewall ruleset a moment to be fully enforced at the
      // // network level before we assert that a direct (no-proxy) call is blocked.
      // await new Promise((resolve) => setTimeout(resolve, 15_000))
    }, 180_000)

    it('blocks requests even when proxy env vars are unset (no proxy bypass)', async () => {
      // Strip every proxy hint so the helper attempts a direct connection,
      // bypassing the proxy entirely. With the "proxy" firewall ruleset egress is
      // enforced at the network level by dropping packets, so a direct connection
      // won't be refused — it just hangs. `timeout` turns that hang into a
      // non-zero exit (124), proving the bypass is blocked rather than silently
      // succeeding.
      const result = await bypassSandbox.process.exec({
        command: `timeout 10 env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy node /tmp/proxy-test.js GET ${echoUrl}/get`,
        waitForCompletion: true,
      })
      expect(result.exitCode, result.logs).not.toBe(0)
    }, 60_000)
  })

  describe.skipIf(isUsingMk3_1())('forbiddenDomains (denylist)', () => {
    let denySandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

    beforeAll(async () => {
      denySandbox = await createReadyProxySandbox(
        async () => {
          const name = uniqueName("fw-deny")
          const sandbox = await SandboxInstance.create({
            name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
            network: { forbiddenDomains: ["example.com"], proxy: { routing: [] } },
          })
          return { name, sandbox }
        },
        createdSandboxes,
        `node /tmp/proxy-test.js GET ${echoUrl}/get`,
      )
    }, 180_000)

    it('allows requests to non-forbidden domain', async () => {
      const result = await execProxyCommandWithRetry(denySandbox, `node /tmp/proxy-test.js GET ${echoUrl}/get`)
      expect(result.exitCode, result.logs).toBe(0)
      expect(result.logs).toContain(echoHost)
    }, 60_000)

    it('blocks requests to forbidden domain', async () => {
      const result = await denySandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://example.com', waitForCompletion: true })
      expect(result.exitCode).not.toBe(0)
    }, 60_000)
  })

  describe.skipIf(isUsingMk3_1())('allowedDomains + forbiddenDomains combined', () => {
    let comboSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

    beforeAll(async () => {
      comboSandbox = await createReadyProxySandbox(
        async () => {
          const name = uniqueName("fw-combo")
          const sandbox = await SandboxInstance.create({
            name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
            network: { allowedDomains: [echoHost, "example.com"], forbiddenDomains: ["example.com"], proxy: { routing: [] } },
          })
          return { name, sandbox }
        },
        createdSandboxes,
        `node /tmp/proxy-test.js GET ${echoUrl}/get`,
      )
    }, 180_000)

    it('allowedDomains takes precedence over forbiddenDomains', async () => {
      const result = await execProxyCommandWithRetry(comboSandbox, `node /tmp/proxy-test.js GET ${echoUrl}/get`)
      expect(result.exitCode, result.logs).toBe(0)
      expect(result.logs).toContain(echoHost)
    }, 60_000)
  })

  describe.skipIf(isUsingMk3_1())('allowedDomains with proxy routing', () => {
    let proxyFwSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

    beforeAll(async () => {
      proxyFwSandbox = await createReadyProxySandbox(
        async () => {
          const name = uniqueName("fw-proxy")
          const sandbox = await SandboxInstance.create({
            name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
            network: {
              allowedDomains: [echoHost],
              proxy: { routing: [{ destinations: [echoHost], headers: { "X-Firewall-Test": "allowed-and-injected" } }] },
            },
          })
          return { name, sandbox }
        },
        createdSandboxes,
        `node /tmp/proxy-test.js GET ${echoUrl}/headers`,
        (result) => {
          if (result.exitCode !== 0) return false
          const response = parseJsonObjectOutput<HttpBinResponse>(result.logs)
          return lowercaseKeys(response.headers)["x-firewall-test"] === "allowed-and-injected"
        },
      )
    }, 180_000)

    it('injects headers for allowlisted and routed domain', async () => {
      const result = await execProxyCommandWithRetry(proxyFwSandbox, `node /tmp/proxy-test.js GET ${echoUrl}/headers`)
      expect(result.exitCode, result.logs).toBe(0)
      const response = parseJsonObjectOutput<HttpBinResponse>(result.logs)
      const headers = lowercaseKeys(response.headers)
      expect(headers["x-firewall-test"]).toBe("allowed-and-injected")
    }, 60_000)

    it('blocks non-allowlisted domain even without routing', async () => {
      const result = await proxyFwSandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://example.com', waitForCompletion: true })
      expect(result.exitCode).not.toBe(0)
    }, 60_000)
  })
})
