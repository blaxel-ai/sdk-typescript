import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from '../helpers.js'
import { lowercaseKeys, parseJsonOutput, proxyCleanup, proxyHelperScript } from './helpers.js'

describe('firewall e2e (allowedDomains / forbiddenDomains)', () => {
  const createdSandboxes: string[] = []
  afterAll(proxyCleanup(createdSandboxes))

  let fwSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

  describe('allowedDomains (allowlist)', () => {
    beforeAll(async () => {
      const name = uniqueName("fw-allow")
      fwSandbox = await SandboxInstance.create({
        name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
        network: { allowedDomains: ["httpbin.org"], proxy: { routing: [] } },
      })
      createdSandboxes.push(name)
      await fwSandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
    }, 60_000)

    it('allows requests to allowlisted domain', async () => {
      const result = await fwSandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://httpbin.org/get', waitForCompletion: true })
      expect(result.exitCode).toBe(0)
      expect(result.logs).toContain("httpbin.org")
    }, 60_000)

    it('blocks requests to non-allowlisted domain', async () => {
      const result = await fwSandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://example.com', waitForCompletion: true })
      expect(result.exitCode).not.toBe(0)
    }, 60_000)
  })

  describe('forbiddenDomains (denylist)', () => {
    let denySandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

    beforeAll(async () => {
      const name = uniqueName("fw-deny")
      denySandbox = await SandboxInstance.create({
        name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
        network: { forbiddenDomains: ["example.com"], proxy: { routing: [] } },
      })
      createdSandboxes.push(name)
      await denySandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
    }, 60_000)

    it('allows requests to non-forbidden domain', async () => {
      const result = await denySandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://httpbin.org/get', waitForCompletion: true })
      expect(result.exitCode).toBe(0)
      expect(result.logs).toContain("httpbin.org")
    }, 60_000)

    it('blocks requests to forbidden domain', async () => {
      const result = await denySandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://example.com', waitForCompletion: true })
      expect(result.exitCode).not.toBe(0)
    }, 60_000)
  })

  describe('allowedDomains + forbiddenDomains combined', () => {
    let comboSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

    beforeAll(async () => {
      const name = uniqueName("fw-combo")
      comboSandbox = await SandboxInstance.create({
        name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
        network: { allowedDomains: ["httpbin.org", "example.com"], forbiddenDomains: ["example.com"], proxy: { routing: [] } },
      })
      createdSandboxes.push(name)
      await comboSandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
    }, 60_000)

    it('allowedDomains takes precedence over forbiddenDomains', async () => {
      const result = await comboSandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://httpbin.org/get', waitForCompletion: true })
      expect(result.exitCode).toBe(0)
      expect(result.logs).toContain("httpbin.org")
    }, 60_000)
  })

  describe('allowedDomains with proxy routing', () => {
    let proxyFwSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

    beforeAll(async () => {
      const name = uniqueName("fw-proxy")
      proxyFwSandbox = await SandboxInstance.create({
        name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
        network: {
          allowedDomains: ["httpbin.org"],
          proxy: { routing: [{ destinations: ["httpbin.org"], headers: { "X-Firewall-Test": "allowed-and-injected" } }] },
        },
      })
      createdSandboxes.push(name)
      await proxyFwSandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
    }, 60_000)

    it('injects headers for allowlisted and routed domain', async () => {
      const result = await proxyFwSandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers', waitForCompletion: true })
      expect(result.exitCode).toBe(0)
      const response = parseJsonOutput(result.logs)
      const headers = lowercaseKeys(response.headers)
      expect(headers["x-firewall-test"]).toBe("allowed-and-injected")
    }, 60_000)

    it('blocks non-allowlisted domain even without routing', async () => {
      const result = await proxyFwSandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://example.com', waitForCompletion: true })
      expect(result.exitCode).not.toBe(0)
    }, 60_000)
  })
})
