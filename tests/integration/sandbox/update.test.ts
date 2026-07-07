import { SandboxInstance, Sandbox as SandboxModel } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, sleep, uniqueName, waitForSandboxDeployed, isUsingMk3_1 } from './helpers.js'
import { createEchoServerSandbox, lowercaseKeys, parseJsonOutput, proxyHelperScript } from './proxy/helpers.js'

describe.runIf(isUsingMk3_1())('Sandbox Update Operations', () => {
  const createdSandboxes: string[] = []

  // A controlled httpbin-compatible upstream (reached via a preview URL) shared by
  // the live-network-call suites below, replacing the flaky public httpbin.org. We
  // use its hostname as the allow/forbid/route target.
  let echoHost: string
  let echoUrl: string

  beforeAll(async () => {
    const echo = await createEchoServerSandbox(createdSandboxes)
    echoHost = echo.host
    echoUrl = echo.url
  }, 180_000)

  afterAll(async () => {
    if (process.env.SKIP_CLEANUP === '1') {
      console.log('SKIP_CLEANUP=1: skipping teardown. Resources to clean up manually:')
      console.log('  Sandboxes:', createdSandboxes)
      return
    }

    await Promise.all(
      createdSandboxes.map(async (name) => {
        try {
          await SandboxInstance.delete(name)
        } catch {
          // Ignore cleanup errors
        }
      })
    )
  })

  async function updateNetwork(name: string, network: SandboxModel['spec']['network']) {
    const instance = await SandboxInstance.updateNetwork(name, { network })
    const deployed = await waitForSandboxDeployed(name, 60)
    expect(deployed).toBe(true)
    return instance
  }

  describe.runIf(isUsingMk3_1())('update network config in-place', () => {
    const MARKER_PATH = '/tmp/update-test-marker.txt'
    const MARKER_CONTENT = 'sandbox-identity-check'
    let name: string

    it('creates a sandbox with forbiddenDomains', async () => {
      name = uniqueName("upd-net")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          forbiddenDomains: ["evil.com", "malware.org"],
        },
      })
      createdSandboxes.push(name)

      expect(sandbox.spec.network?.forbiddenDomains).toEqual(["evil.com", "malware.org"])
    })

    it('writes a marker file to detect replacement', async () => {
      const sandbox = await SandboxInstance.get(name)
      await sandbox.fs.write(MARKER_PATH, MARKER_CONTENT)
      const read = await sandbox.fs.read(MARKER_PATH)
      expect(read).toBe(MARKER_CONTENT)
    })

    it('updates the sandbox to remove forbiddenDomains', async () => {
      const updated = await updateNetwork(name, {})

      expect(updated.metadata?.name).toBe(name)
      expect(updated.spec?.network?.forbiddenDomains).toBeUndefined()
    })

    it('sandbox was NOT replaced — marker file still exists', async () => {
      const sandbox = await SandboxInstance.get(name)
      const read = await sandbox.fs.read(MARKER_PATH)
      expect(read).toBe(MARKER_CONTENT)
    })

    it('sandbox is still functional after update', async () => {
      const sandbox = await SandboxInstance.get(name)
      const result = await sandbox.process.exec({
        command: "echo 'alive'",
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)
      expect(result.logs).toContain("alive")
    })
  })

  describe.runIf(isUsingMk3_1())('add and remove proxy config in-place', () => {
    const MARKER_PATH = '/tmp/proxy-update-marker.txt'
    const MARKER_CONTENT = 'proxy-identity-check'
    let name: string

    it('creates a sandbox without proxy', async () => {
      name = uniqueName("upd-proxy")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      expect(sandbox.spec.network?.proxy).toBeUndefined()
    })

    it('writes a marker file', async () => {
      const sandbox = await SandboxInstance.get(name)
      await sandbox.fs.write(MARKER_PATH, MARKER_CONTENT)
    })

    it('adds proxy routing via update', async () => {
      const updated = await updateNetwork(name, {
        proxy: {
          routing: [
            {
              destinations: ["httpbin.org"],
              headers: { "X-Added-Via-Update": "true" },
            },
          ],
        },
      })

      expect(updated.metadata?.name).toBe(name)
      expect(updated.spec?.network?.proxy?.routing).toHaveLength(1)
      expect(updated.spec?.network?.proxy?.routing?.[0]?.destinations).toContain("httpbin.org")
      expect(updated.spec?.network?.proxy?.routing?.[0]?.headers?.["X-Added-Via-Update"]).toBe("true")
    })

    it('marker file survives proxy addition', async () => {
      const sandbox = await SandboxInstance.get(name)
      const read = await sandbox.fs.read(MARKER_PATH)
      expect(read).toBe(MARKER_CONTENT)
    })

    it('removes proxy routing via update', async () => {
      const updated = await updateNetwork(name, {})

      expect(updated.metadata?.name).toBe(name)
      expect(updated.spec?.network?.proxy).toBeUndefined()
    })

    it('marker file survives proxy removal', async () => {
      const sandbox = await SandboxInstance.get(name)
      const read = await sandbox.fs.read(MARKER_PATH)
      expect(read).toBe(MARKER_CONTENT)
    })
  })

  describe.runIf(isUsingMk3_1())('swap network config (forbiddenDomains → allowedDomains)', () => {
    const MARKER_PATH = '/tmp/swap-update-marker.txt'
    const MARKER_CONTENT = 'swap-identity-check'
    let name: string

    it('creates a sandbox with forbiddenDomains', async () => {
      name = uniqueName("upd-swap")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          forbiddenDomains: ["evil.com"],
        },
      })
      createdSandboxes.push(name)

      await sandbox.fs.write(MARKER_PATH, MARKER_CONTENT)
      expect(sandbox.spec.network?.forbiddenDomains).toEqual(["evil.com"])
    })

    it('replaces forbiddenDomains with allowedDomains in one update', async () => {
      const updated = await updateNetwork(name, {
        allowedDomains: ["httpbin.org", "example.com"],
      })

      expect(updated.metadata?.name).toBe(name)
      expect(updated.spec?.network?.forbiddenDomains).toBeUndefined()
      expect(updated.spec?.network?.allowedDomains).toEqual(["httpbin.org", "example.com"])
    })

    it('marker file survives the swap', async () => {
      const sandbox = await SandboxInstance.get(name)
      const read = await sandbox.fs.read(MARKER_PATH)
      expect(read).toBe(MARKER_CONTENT)
    })
  })

  describe.runIf(isUsingMk3_1())('update network config with proxy + firewall combined', () => {
    let name: string

    it('creates a sandbox with allowedDomains only', async () => {
      name = uniqueName("upd-combo")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          allowedDomains: ["httpbin.org"],
        },
      })
      createdSandboxes.push(name)

      expect(sandbox.spec.network?.allowedDomains).toEqual(["httpbin.org"])
      expect(sandbox.spec.network?.proxy).toBeUndefined()
    })

    it('adds proxy routing while keeping allowedDomains', async () => {
      const current = await SandboxInstance.get(name)
      const updated = await updateNetwork(name, {
        allowedDomains: current.spec.network?.allowedDomains,
        proxy: {
          routing: [
            {
              destinations: ["httpbin.org"],
              headers: { "X-Combo-Test": "injected" },
            },
          ],
        },
      })

      expect(updated.spec?.network?.allowedDomains).toEqual(["httpbin.org"])
      expect(updated.spec?.network?.proxy?.routing).toHaveLength(1)
    })

    it('expands allowedDomains and adds bypass in one update', async () => {
      const updated = await updateNetwork(name, {
        allowedDomains: ["httpbin.org", "api.github.com"],
        proxy: {
          routing: [
            {
              destinations: ["httpbin.org"],
              headers: { "X-Combo-Test": "injected" },
            },
          ],
          bypass: ["*.s3.amazonaws.com"],
        },
      })

      expect(updated.spec?.network?.allowedDomains).toEqual(["httpbin.org", "api.github.com"])
      expect(updated.spec?.network?.proxy?.bypass).toContain("*.s3.amazonaws.com")
      expect(updated.spec?.network?.proxy?.routing).toHaveLength(1)
    })

    it('strips everything back to no network config', async () => {
      const updated = await updateNetwork(name, undefined)

      expect(updated.metadata?.name).toBe(name)
      expect(updated.spec?.network?.allowedDomains).toBeUndefined()
      expect(updated.spec?.network?.proxy).toBeUndefined()
    })
  })

  describe.runIf(isUsingMk3_1())('multiple sequential updates preserve sandbox identity', () => {
    const MARKER_PATH = '/tmp/seq-update-marker.txt'
    let name: string

    it('survives 5 sequential network config changes', async () => {
      name = uniqueName("upd-seq")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      await sandbox.fs.write(MARKER_PATH, 'round-0')

      const configs: Array<SandboxModel['spec']['network']> = [
        { forbiddenDomains: ["evil.com"] },
        { allowedDomains: ["httpbin.org"] },
        { allowedDomains: ["httpbin.org"], proxy: { routing: [{ destinations: ["httpbin.org"], headers: { "X-Round": "3" } }] } },
        { proxy: { bypass: ["*.s3.amazonaws.com"] } },
        {},
      ]

      for (let i = 0; i < configs.length; i++) {
        const updated = await updateNetwork(name, configs[i])
        expect(updated.metadata?.name).toBe(name)

        const sb = await SandboxInstance.get(name)
        await sb.fs.write(MARKER_PATH, `round-${i + 1}`)
        const read = await sb.fs.read(MARKER_PATH)
        expect(read).toBe(`round-${i + 1}`)
      }

      const final = await SandboxInstance.get(name)
      const read = await final.fs.read(MARKER_PATH)
      expect(read).toBe('round-5')
      expect(final.spec.network?.proxy).toBeUndefined()
      expect(final.spec.network?.allowedDomains).toBeUndefined()
      expect(final.spec.network?.forbiddenDomains).toBeUndefined()
    }, 120_000)
  })

  describe.runIf(isUsingMk3_1())('forbiddenDomains update verified with live network calls', () => {
    let name: string
    let sandbox: Awaited<ReturnType<typeof SandboxInstance.get>>

    it('creates sandbox with echo host forbidden', async () => {
      name = uniqueName("upd-fw-live")
      const created = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          forbiddenDomains: [echoHost],
          proxy: { routing: [] },
        },
      })
      createdSandboxes.push(name)
      sandbox = created as any

      await sandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
    }, 60_000)

    it('echo host is blocked before update', async () => {
      const result = await sandbox.process.exec({
        command: `node /tmp/proxy-test.js GET ${echoUrl}/get`,
        waitForCompletion: true,
      })
      expect(result.exitCode).not.toBe(0)
    }, 60_000)

    it('removes forbiddenDomains via update', async () => {
      const updated = await updateNetwork(name, { proxy: { routing: [] } })
      expect(updated.spec?.network?.forbiddenDomains).toBeUndefined()
      sandbox = await SandboxInstance.get(name)
    })

    it('echo host is reachable after update', async () => {
      // Firewall rule propagation may lag behind DEPLOYED status — retry until reachable
      let result: Awaited<ReturnType<typeof sandbox.process.exec>> | undefined
      for (let i = 0; i < 15; i++) {
        result = await sandbox.process.exec({
          command: `node /tmp/proxy-test.js GET ${echoUrl}/get`,
          waitForCompletion: true,
        })
        if (result.exitCode === 0) break
        await sleep(2000)
      }
      expect(result!.exitCode).toBe(0)
      expect(result!.logs).toContain(echoHost)
    }, 60_000)
  })

  describe.runIf(isUsingMk3_1())('allowedDomains update verified with live network calls', () => {
    let name: string
    let sandbox: Awaited<ReturnType<typeof SandboxInstance.get>>

    it('creates sandbox with only echo host allowed', async () => {
      name = uniqueName("upd-allow-live")
      const created = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          allowedDomains: [echoHost],
          proxy: { routing: [] },
        },
      })
      createdSandboxes.push(name)
      sandbox = created as any

      await sandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
    }, 60_000)

    it('echo host is reachable', async () => {
      const result = await sandbox.process.exec({
        command: `node /tmp/proxy-test.js GET ${echoUrl}/get`,
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)
    }, 60_000)

    it('example.com is blocked', async () => {
      const result = await sandbox.process.exec({
        command: 'node /tmp/proxy-test.js GET https://example.com',
        waitForCompletion: true,
      })
      expect(result.exitCode).not.toBe(0)
    }, 60_000)

    it('expands allowedDomains to include example.com', async () => {
      const updated = await updateNetwork(name, {
        allowedDomains: [echoHost, "example.com"],
        proxy: { routing: [] },
      })
      expect(updated.spec?.network?.allowedDomains).toEqual([echoHost, "example.com"])
      sandbox = await SandboxInstance.get(name)
    })

    it('example.com is now reachable after update', async () => {
      const result = await sandbox.process.exec({
        command: 'node /tmp/proxy-test.js GET https://example.com',
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)
      expect(result.logs!.length).toBeGreaterThan(0)
    }, 60_000)

    it('echo host is still reachable', async () => {
      const result = await sandbox.process.exec({
        command: `node /tmp/proxy-test.js GET ${echoUrl}/get`,
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)
    }, 60_000)
  })

  describe.runIf(isUsingMk3_1())('proxy header injection update verified with live network calls', () => {
    let name: string
    let sandbox: Awaited<ReturnType<typeof SandboxInstance.get>>

    it('creates sandbox with initial proxy routing rule', async () => {
      name = uniqueName("upd-hdr-live")
      const created = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          proxy: {
            routing: [
              {
                destinations: [echoHost],
                headers: { "X-Update-Test": "initial-value" },
              },
            ],
          },
        },
      })
      createdSandboxes.push(name)
      sandbox = created as any

      await sandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
    }, 60_000)

    it('initial routing rule injects headers', async () => {
      const result = await sandbox.process.exec({
        command: `node /tmp/proxy-test.js GET ${echoUrl}/headers`,
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      const headers = lowercaseKeys(response.headers)
      expect(headers["x-update-test"]).toBe("initial-value")
    }, 60_000)

    it('updates routing rule with new header and secret', async () => {
      const updated = await updateNetwork(name, {
        proxy: {
          routing: [
            {
              destinations: [echoHost],
              headers: {
                "X-Update-Test": "changed-via-update",
                "X-Api-Key": "{{SECRET:test-key}}",
              },
              secrets: {
                "test-key": "secret-value-42",
              },
            },
          ],
        },
      })
      expect(updated.spec?.network?.proxy?.routing).toHaveLength(1)
      sandbox = await SandboxInstance.get(name)
    })

    it('updated headers and resolved secret appear', async () => {
      const result = await sandbox.process.exec({
        command: `node /tmp/proxy-test.js GET ${echoUrl}/headers`,
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      const headers = lowercaseKeys(response.headers)
      expect(headers["x-update-test"]).toBe("changed-via-update")
      expect(headers["x-api-key"]).toBe("secret-value-42")
    }, 60_000)

    it('updates again — drops secret, changes header value', async () => {
      await updateNetwork(name, {
        proxy: {
          routing: [
            {
              destinations: [echoHost],
              headers: {
                "X-Update-Test": "third-value",
              },
            },
          ],
        },
      })
      sandbox = await SandboxInstance.get(name)

      const result = await sandbox.process.exec({
        command: `node /tmp/proxy-test.js GET ${echoUrl}/headers`,
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      const headers = lowercaseKeys(response.headers)
      expect(headers["x-update-test"]).toBe("third-value")
      expect(headers["x-api-key"]).toBeUndefined()
    }, 60_000)
  })
})
