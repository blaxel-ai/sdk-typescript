import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, isSlowTestEnabled, uniqueName } from '../helpers.js'
import { createEchoServerSandbox, createReadyProxySandbox, execProxyCommandWithRetry, lowercaseKeys, parseJsonObjectOutput, proxyCleanup, rawProxyRequestScript } from './helpers.js'

type Sandbox = Awaited<ReturnType<typeof SandboxInstance.create>>

type RawResponse = {
  status: number
  body: string
}

type HttpBinResponse = {
  headers: Record<string, string>
}

describe('firewall e2e (allowedDomains / forbiddenDomains)', () => {
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

  describe('allowedDomains (allowlist)', () => {
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

  describe.runIf(isSlowTestEnabled("RUN_FIREWALL_RULESET_TESTS"))('no proxy bypass (firewall ruleset: proxy)', () => {
    let bypassSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

    beforeAll(async () => {
      const readyStart = Date.now()
      bypassSandbox = await createReadyProxySandbox(
        async () => {
          const name = uniqueName("fw-bypass")
          // console.log(`[fw-bypass] creating sandbox ${name}...`)
          const createStart = Date.now()
          const sandbox = await SandboxInstance.create({
            name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
            network: {
              firewall: { rulesets: ["proxy"] },
              allowedDomains: [echoHost],
              proxy: { routing: [] },
            },
          })
          // console.log(`[fw-bypass] SandboxInstance.create took ${Date.now() - createStart}ms`)
          return { name, sandbox }
        },
        createdSandboxes,
        `node /tmp/proxy-test.js GET ${echoUrl}/get`,
      )
      // console.log(`[fw-bypass] sandbox ready (create + proxy warmup) took ${Date.now() - readyStart}ms`)

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

  // Sends a raw request through the proxy (see rawProxyRequestScript).
  const rawRequest = async (sandbox: Sandbox, method: string, target: string, host = ""): Promise<RawResponse> => {
    const result = await sandbox.process.exec({
      command: `node /tmp/raw-proxy.js ${method} '${target}' '${host}'`,
      waitForCompletion: true,
    })
    const line = (result.logs ?? "").trim().split("\n").filter(l => l.startsWith('{"status"')).pop()
    expect(line, result.logs).toBeDefined()
    return JSON.parse(line!) as RawResponse
  }

  // A 403 from the upstream site is not a block: require the proxy's own error body.
  const expectProxyBlocked = (res: RawResponse) => {
    expect(res.status, res.body).toBe(403)
    expect(res.body).toContain("firewall_blocked")
  }

  const resolveIPv4 = async (sandbox: Sandbox, host: string): Promise<string> => {
    const result = await sandbox.process.exec({
      command: `node -e 'require("dns").lookup("${host}", { family: 4 }, (e, a) => { if (e) { console.error(e.message); process.exit(1) } console.log(a) })'`,
      waitForCompletion: true,
    })
    const ip = (result.logs ?? "").trim().split("\n").pop() ?? ""
    expect(ip, result.logs).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    return ip
  }

  describe.runIf(isSlowTestEnabled("RUN_FIREWALL_RULESET_TESTS"))('allowlist of one domain (firewall ruleset: proxy)', () => {
    let allowOnlySandbox: Sandbox
    let exampleIP: string

    beforeAll(async () => {
      allowOnlySandbox = await createReadyProxySandbox(
        async () => {
          const name = uniqueName("fw-allow-only")
          const sandbox = await SandboxInstance.create({
            name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
            network: {
              firewall: { rulesets: ["proxy"] },
              allowedDomains: ["example.com"],
              proxy: { routing: [] },
            },
          })
          return { name, sandbox }
        },
        createdSandboxes,
        'node /tmp/proxy-test.js GET https://example.com/',
      )
      await allowOnlySandbox.fs.write("/tmp/raw-proxy.js", rawProxyRequestScript)
      exampleIP = await resolveIPv4(allowOnlySandbox, "example.com")
    }, 180_000)

    it('allows the allowlisted domain over HTTPS', async () => {
      const result = await execProxyCommandWithRetry(allowOnlySandbox, 'node /tmp/proxy-test.js GET https://example.com/')
      expect(result.exitCode, result.logs).toBe(0)
      expect(result.logs).toContain("Example Domain")
    }, 60_000)

    it('allows the allowlisted domain over plain HTTP', async () => {
      const res = await rawRequest(allowOnlySandbox, "GET", "http://example.com/", "example.com")
      expect(res.status, res.body).toBe(200)
    }, 60_000)

    it('treats a trailing root dot as the same allowlisted domain', async () => {
      const res = await rawRequest(allowOnlySandbox, "GET", "http://example.com./", "example.com.")
      expect(res.body).not.toContain("firewall_blocked")
      expect(res.status, res.body).not.toBe(0)
    }, 60_000)

    it('blocks every other domain over HTTPS', async () => {
      const result = await allowOnlySandbox.process.exec({ command: `node /tmp/proxy-test.js GET ${echoUrl}/get`, waitForCompletion: true })
      expect(result.exitCode).not.toBe(0)
      expect(result.logs).toContain("CONNECT 403")
    }, 60_000)

    it('blocks every other domain over plain HTTP', async () => {
      const res = await rawRequest(allowOnlySandbox, "GET", `http://${echoHost}/get`, echoHost)
      expectProxyBlocked(res)
    }, 60_000)

    it("blocks the allowlisted domain's IP address, which is not on the allowlist", async () => {
      const res = await rawRequest(allowOnlySandbox, "GET", `http://${exampleIP}/`, "example.com")
      expectProxyBlocked(res)
      const connect = await rawRequest(allowOnlySandbox, "CONNECT", `${exampleIP}:443`)
      expectProxyBlocked(connect)
    }, 60_000)

    it('blocks a direct connection that skips the proxy', async () => {
      const result = await allowOnlySandbox.process.exec({
        command: 'timeout 10 env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy node /tmp/proxy-test.js GET https://example.com/',
        waitForCompletion: true,
      })
      expect(result.exitCode, result.logs).not.toBe(0)
    }, 60_000)
  })

  describe('forbiddenDomains (denylist)', () => {
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

  describe('allowedDomains + forbiddenDomains combined', () => {
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

  describe('allowedDomains with proxy routing', () => {
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
