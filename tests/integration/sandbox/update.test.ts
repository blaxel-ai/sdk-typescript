import { SandboxInstance, updateSandbox, Sandbox as SandboxModel } from "@blaxel/core"
import { afterAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, sleep, uniqueName, waitForSandboxDeployed } from './helpers.js'

const proxyHelperScript = `
const https = require("https");
const tls = require("tls");
const method = process.argv[2] || "GET";
const targetUrl = process.argv[3] || "https://httpbin.org/headers";
const extraHeaders = process.argv[4] ? JSON.parse(process.argv[4]) : {};
const bodyData = process.argv[5] || null;
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy ||
                 process.env.HTTP_PROXY || process.env.http_proxy;

function fire(socket) {
  const t = new URL(targetUrl);
  const opts = {
    hostname: t.hostname, port: t.port || 443,
    path: t.pathname + t.search, method,
    headers: { ...extraHeaders }, servername: t.hostname,
  };
  if (socket) { opts.socket = socket; opts.agent = false; }
  if (bodyData) {
    opts.headers["Content-Type"] = "application/json";
    opts.headers["Content-Length"] = Buffer.byteLength(bodyData);
  }
  const req = https.request(opts, (r) => {
    let d = ""; r.on("data", c => d += c);
    r.on("end", () => { process.stdout.write(d); process.exit(0); });
  });
  req.on("error", (e) => { process.stderr.write("REQ ERR: " + e.message + "\\n"); process.exit(1); });
  if (bodyData) req.write(bodyData);
  req.end();
}

if (!proxyUrl) { fire(null); }
else {
  const p = new URL(proxyUrl);
  const t = new URL(targetUrl);
  const port = parseInt(p.port) || (p.protocol === "https:" ? 443 : 3128);
  const auth = (p.username || p.password)
    ? "Proxy-Authorization: Basic " +
      Buffer.from(decodeURIComponent(p.username||"") + ":" + decodeURIComponent(p.password||"")).toString("base64") + "\\r\\n"
    : "";
  const connectMsg = "CONNECT " + t.hostname + ":443 HTTP/1.1\\r\\n" +
    "Host: " + t.hostname + ":443\\r\\n" + auth + "\\r\\n";

  function onSocket(sock) {
    let buf = "";
    sock.on("data", function h(chunk) {
      buf += chunk.toString();
      if (buf.indexOf("\\r\\n\\r\\n") < 0) return;
      sock.removeListener("data", h);
      const code = parseInt(buf.split(" ")[1]);
      if (code !== 200) {
        process.stderr.write("CONNECT " + code + "\\n");
        process.exit(1);
      }
      fire(sock);
    });
    sock.write(connectMsg);
  }

  const timeout = setTimeout(() => { process.stderr.write("PROXY TIMEOUT\\n"); process.exit(1); }, 15000);
  if (p.protocol === "https:") {
    const s = tls.connect({ host: p.hostname, port }, () => { clearTimeout(timeout); onSocket(s); });
    s.on("error", (e) => { clearTimeout(timeout); process.stderr.write("PROXY TLS: " + e.message + "\\n"); process.exit(1); });
  } else {
    const s = require("net").connect({ host: p.hostname, port }, () => { clearTimeout(timeout); onSocket(s); });
    s.on("error", (e) => { clearTimeout(timeout); process.stderr.write("PROXY TCP: " + e.message + "\\n"); process.exit(1); });
  }
}
`.trim()

function parseJsonOutput(logs: string | undefined): any {
  if (!logs) throw new Error("No output from command")
  const trimmed = logs.trim()
  const jsonStart = trimmed.indexOf('{')
  if (jsonStart === -1) throw new Error(`No JSON found in output: ${trimmed.slice(0, 200)}`)
  let depth = 0
  let jsonEnd = -1
  for (let i = jsonStart; i < trimmed.length; i++) {
    if (trimmed[i] === '{') depth++
    else if (trimmed[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break } }
  }
  if (jsonEnd === -1) throw new Error(`Unterminated JSON in output: ${trimmed.slice(0, 300)}`)
  return JSON.parse(trimmed.slice(jsonStart, jsonEnd))
}

function lowercaseKeys(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v])
  )
}

describe('Sandbox Update Operations', () => {
  const createdSandboxes: string[] = []

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

  async function rawUpdate(name: string, specPatch: Partial<SandboxModel['spec']>) {
    const current = await SandboxInstance.get(name)
    const body = {
      metadata: current.metadata,
      spec: { ...current.spec, ...specPatch },
    } as SandboxModel
    const { data } = await updateSandbox({
      path: { sandboxName: name },
      body,
      throwOnError: true,
    })
    const deployed = await waitForSandboxDeployed(name, 60)
    expect(deployed).toBe(true)
    return data
  }

  describe('update network config in-place', () => {
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
      const updated = await rawUpdate(name, {
        network: {},
      })

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

  describe('add and remove proxy config in-place', () => {
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
      const updated = await rawUpdate(name, {
        network: {
          proxy: {
            routing: [
              {
                destinations: ["httpbin.org"],
                headers: { "X-Added-Via-Update": "true" },
              },
            ],
          },
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
      const updated = await rawUpdate(name, {
        network: {},
      })

      expect(updated.metadata?.name).toBe(name)
      expect(updated.spec?.network?.proxy).toBeUndefined()
    })

    it('marker file survives proxy removal', async () => {
      const sandbox = await SandboxInstance.get(name)
      const read = await sandbox.fs.read(MARKER_PATH)
      expect(read).toBe(MARKER_CONTENT)
    })
  })

  describe('swap network config (forbiddenDomains → allowedDomains)', () => {
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
      const updated = await rawUpdate(name, {
        network: {
          allowedDomains: ["httpbin.org", "example.com"],
        },
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

  describe('update network config with proxy + firewall combined', () => {
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
      const updated = await rawUpdate(name, {
        network: {
          allowedDomains: current.spec.network?.allowedDomains,
          proxy: {
            routing: [
              {
                destinations: ["httpbin.org"],
                headers: { "X-Combo-Test": "injected" },
              },
            ],
          },
        },
      })

      expect(updated.spec?.network?.allowedDomains).toEqual(["httpbin.org"])
      expect(updated.spec?.network?.proxy?.routing).toHaveLength(1)
    })

    it('expands allowedDomains and adds bypass in one update', async () => {
      const updated = await rawUpdate(name, {
        network: {
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
        },
      })

      expect(updated.spec?.network?.allowedDomains).toEqual(["httpbin.org", "api.github.com"])
      expect(updated.spec?.network?.proxy?.bypass).toContain("*.s3.amazonaws.com")
      expect(updated.spec?.network?.proxy?.routing).toHaveLength(1)
    })

    it('strips everything back to no network config', async () => {
      const updated = await rawUpdate(name, {
        network: undefined,
      })

      expect(updated.metadata?.name).toBe(name)
      expect(updated.spec?.network?.allowedDomains).toBeUndefined()
      expect(updated.spec?.network?.proxy).toBeUndefined()
    })
  })

  describe('multiple sequential updates preserve sandbox identity', () => {
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

      const configs: Array<Partial<SandboxModel['spec']>> = [
        { network: { forbiddenDomains: ["evil.com"] } },
        { network: { allowedDomains: ["httpbin.org"] } },
        { network: { allowedDomains: ["httpbin.org"], proxy: { routing: [{ destinations: ["httpbin.org"], headers: { "X-Round": "3" } }] } } },
        { network: { proxy: { bypass: ["*.s3.amazonaws.com"] } } },
        { network: {} },
      ]

      for (let i = 0; i < configs.length; i++) {
        const updated = await rawUpdate(name, configs[i])
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

  describe('forbiddenDomains update verified with live network calls', () => {
    let name: string
    let sandbox: Awaited<ReturnType<typeof SandboxInstance.get>>

    it('creates sandbox with httpbin.org forbidden', async () => {
      name = uniqueName("upd-fw-live")
      const created = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          forbiddenDomains: ["httpbin.org"],
          proxy: { routing: [] },
        },
      })
      createdSandboxes.push(name)
      sandbox = created as any

      await sandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
    }, 60_000)

    it('httpbin.org is blocked before update', async () => {
      const result = await sandbox.process.exec({
        command: 'node /tmp/proxy-test.js GET https://httpbin.org/get',
        waitForCompletion: true,
      })
      expect(result.exitCode).not.toBe(0)
    }, 60_000)

    it('removes forbiddenDomains via update', async () => {
      const updated = await rawUpdate(name, {
        network: { proxy: { routing: [] } },
      })
      expect(updated.spec?.network?.forbiddenDomains).toBeUndefined()
      sandbox = await SandboxInstance.get(name)
    })

    it('httpbin.org is reachable after update', async () => {
      // Firewall rule propagation may lag behind DEPLOYED status — retry until reachable
      let result: Awaited<ReturnType<typeof sandbox.process.exec>> | undefined
      for (let i = 0; i < 15; i++) {
        result = await sandbox.process.exec({
          command: 'node /tmp/proxy-test.js GET https://httpbin.org/get',
          waitForCompletion: true,
        })
        if (result.exitCode === 0) break
        await sleep(2000)
      }
      expect(result!.exitCode).toBe(0)
      expect(result!.logs).toContain("httpbin.org")
    }, 60_000)
  })

  describe('allowedDomains update verified with live network calls', () => {
    let name: string
    let sandbox: Awaited<ReturnType<typeof SandboxInstance.get>>

    it('creates sandbox with only httpbin.org allowed', async () => {
      name = uniqueName("upd-allow-live")
      const created = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          allowedDomains: ["httpbin.org"],
          proxy: { routing: [] },
        },
      })
      createdSandboxes.push(name)
      sandbox = created as any

      await sandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
    }, 60_000)

    it('httpbin.org is reachable', async () => {
      const result = await sandbox.process.exec({
        command: 'node /tmp/proxy-test.js GET https://httpbin.org/get',
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
      const updated = await rawUpdate(name, {
        network: {
          allowedDomains: ["httpbin.org", "example.com"],
          proxy: { routing: [] },
        },
      })
      expect(updated.spec?.network?.allowedDomains).toEqual(["httpbin.org", "example.com"])
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

    it('httpbin.org is still reachable', async () => {
      const result = await sandbox.process.exec({
        command: 'node /tmp/proxy-test.js GET https://httpbin.org/get',
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)
    }, 60_000)
  })

  describe('proxy header injection update verified with live network calls', () => {
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
                destinations: ["httpbin.org"],
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
        command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers',
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      const headers = lowercaseKeys(response.headers)
      expect(headers["x-update-test"]).toBe("initial-value")
      expect(headers["x-blaxel-request-id"]).toBeDefined()
    }, 60_000)

    it('updates routing rule with new header and secret', async () => {
      const updated = await rawUpdate(name, {
        network: {
          proxy: {
            routing: [
              {
                destinations: ["httpbin.org"],
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
        },
      })
      expect(updated.spec?.network?.proxy?.routing).toHaveLength(1)
      sandbox = await SandboxInstance.get(name)
    })

    it('updated headers and resolved secret appear', async () => {
      const result = await sandbox.process.exec({
        command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers',
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      const headers = lowercaseKeys(response.headers)
      expect(headers["x-update-test"]).toBe("changed-via-update")
      expect(headers["x-api-key"]).toBe("secret-value-42")
    }, 60_000)

    it('updates again — drops secret, changes header value', async () => {
      await rawUpdate(name, {
        network: {
          proxy: {
            routing: [
              {
                destinations: ["httpbin.org"],
                headers: {
                  "X-Update-Test": "third-value",
                },
              },
            ],
          },
        },
      })
      sandbox = await SandboxInstance.get(name)

      const result = await sandbox.process.exec({
        command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers',
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
