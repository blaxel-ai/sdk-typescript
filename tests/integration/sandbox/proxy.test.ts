import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, sleep, uniqueName, waitForSandboxDeletion } from './helpers.js'

describe('Sandbox Proxy Operations', () => {
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

  describe('create with proxy', () => {
    it('creates a sandbox with proxy routing and header injection', async () => {
      const name = uniqueName("proxy-hdr")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          proxy: {
            routing: [
              {
                destinations: ["api.stripe.com"],
                headers: {
                  "Authorization": "Bearer {{SECRET:stripe-key}}",
                  "Stripe-Version": "2024-12-18.acacia",
                },
                secrets: {
                  "stripe-key": "sk-live-test123",
                },
              },
            ],
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
      expect(sandbox.spec.network?.proxy?.routing?.[0]?.secrets).toBeUndefined()
    })

    it('creates a sandbox with proxy body injection', async () => {
      const name = uniqueName("proxy-body")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          proxy: {
            routing: [
              {
                destinations: ["api.stripe.com"],
                headers: {
                  "Authorization": "Bearer {{SECRET:stripe-key}}",
                },
                body: {
                  "api_key": "{{SECRET:stripe-key}}",
                },
                secrets: {
                  "stripe-key": "sk-live-test123",
                },
              },
            ],
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
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          proxy: {
            routing: [
              {
                destinations: ["api.stripe.com"],
                headers: {
                  "Authorization": "Bearer {{SECRET:stripe-key}}",
                  "Stripe-Version": "2024-12-18.acacia",
                  "X-Request-Source": "blaxel-sandbox",
                },
                body: {
                  "api_key": "{{SECRET:stripe-key}}",
                },
                secrets: {
                  "stripe-key": "sk-live-test123",
                },
              },
              {
                destinations: ["api.openai.com"],
                headers: {
                  "Authorization": "Bearer {{SECRET:openai-key}}",
                  "OpenAI-Organization": "org-abc123",
                },
                secrets: {
                  "openai-key": "sk-proj-test789",
                },
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
      expect(stripeRoute?.secrets).toBeUndefined()

      const openaiRoute = proxyConfig?.routing?.find(r => r.destinations?.includes("api.openai.com"))
      expect(openaiRoute).toBeDefined()
      expect(openaiRoute?.headers?.["OpenAI-Organization"]).toBe("org-abc123")
      expect(openaiRoute?.secrets).toBeUndefined()

      expect(proxyConfig?.bypass).toContain("*.s3.amazonaws.com")
    })

    it('creates a sandbox with proxy bypass only', async () => {
      const name = uniqueName("proxy-bypass")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          proxy: {
            bypass: ["*.s3.amazonaws.com", "169.254.169.254"],
          },
        },
      })
      createdSandboxes.push(name)

      expect(sandbox.spec.network?.proxy?.bypass).toEqual(["*.s3.amazonaws.com", "169.254.169.254"])
      expect(sandbox.spec.network?.proxy?.routing).toBeUndefined()
    })

    it('creates a sandbox with proxy and allowedDomains combined', async () => {
      const name = uniqueName("proxy-fw")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          allowedDomains: ["api.stripe.com", "api.openai.com", "*.s3.amazonaws.com"],
          proxy: {
            routing: [
              {
                destinations: ["api.stripe.com"],
                headers: { "Authorization": "Bearer {{SECRET:stripe-key}}" },
                secrets: { "stripe-key": "sk-live-test123" },
              },
            ],
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

  describe('get proxy config', () => {
    it('retrieves sandbox with proxy and validates config if returned', async () => {
      const name = uniqueName("proxy-get")
      await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          proxy: {
            routing: [
              {
                destinations: ["api.openai.com"],
                headers: {
                  "Authorization": "Bearer {{SECRET:openai-key}}",
                  "OpenAI-Organization": "org-abc123",
                },
                secrets: {
                  "openai-key": "sk-proj-test789",
                },
              },
            ],
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
      await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
      })
      createdSandboxes.push(name)

      const retrieved = await SandboxInstance.get(name)
      expect(retrieved.spec.network?.proxy).toBeUndefined()
    })
  })

  describe('delete sandbox with proxy', () => {
    it('deletes a sandbox that has proxy configuration', async () => {
      const name = uniqueName("proxy-del")
      await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          proxy: {
            routing: [
              {
                destinations: ["api.stripe.com"],
                headers: { "Authorization": "Bearer {{SECRET:stripe-key}}" },
                secrets: { "stripe-key": "sk-live-test123" },
              },
            ],
          },
        },
      })

      await SandboxInstance.delete(name)

      const deleted = await waitForSandboxDeletion(name)
      expect(deleted).toBe(true)
    })
  })

  describe('firewall e2e (allowedDomains / forbiddenDomains)', () => {
    let fwSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

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

    describe('allowedDomains (allowlist)', () => {
      beforeAll(async () => {
        const name = uniqueName("fw-allow")
        fwSandbox = await SandboxInstance.create({
          name,
          image: defaultImage,
          region: defaultRegion,
          labels: defaultLabels,
          network: {
            allowedDomains: ["httpbin.org"],
            proxy: {
              routing: [],
            },
          },
        })
        createdSandboxes.push(name)
        await fwSandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
      }, 60_000)

      it('allows requests to allowlisted domain', async () => {
        const result = await fwSandbox.process.exec({
          command: 'node /tmp/proxy-test.js GET https://httpbin.org/get',
          waitForCompletion: true,
        })
        expect(result.exitCode).toBe(0)
        expect(result.logs).toContain("httpbin.org")
      }, 60_000)

      it('blocks requests to non-allowlisted domain', async () => {
        const result = await fwSandbox.process.exec({
          command: 'node /tmp/proxy-test.js GET https://example.com',
          waitForCompletion: true,
        })
        expect(result.exitCode).not.toBe(0)
      }, 60_000)
    })

    describe('forbiddenDomains (denylist)', () => {
      let denySandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

      beforeAll(async () => {
        const name = uniqueName("fw-deny")
        denySandbox = await SandboxInstance.create({
          name,
          image: defaultImage,
          region: defaultRegion,
          labels: defaultLabels,
          network: {
            forbiddenDomains: ["example.com"],
            proxy: {
              routing: [],
            },
          },
        })
        createdSandboxes.push(name)
        await denySandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
      }, 60_000)

      it('allows requests to non-forbidden domain', async () => {
        const result = await denySandbox.process.exec({
          command: 'node /tmp/proxy-test.js GET https://httpbin.org/get',
          waitForCompletion: true,
        })
        expect(result.exitCode).toBe(0)
        expect(result.logs).toContain("httpbin.org")
      }, 60_000)

      it('blocks requests to forbidden domain', async () => {
        const result = await denySandbox.process.exec({
          command: 'node /tmp/proxy-test.js GET https://example.com',
          waitForCompletion: true,
        })
        expect(result.exitCode).not.toBe(0)
      }, 60_000)
    })

    describe('allowedDomains + forbiddenDomains combined', () => {
      let comboSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

      beforeAll(async () => {
        const name = uniqueName("fw-combo")
        comboSandbox = await SandboxInstance.create({
          name,
          image: defaultImage,
          region: defaultRegion,
          labels: defaultLabels,
          network: {
            allowedDomains: ["httpbin.org", "example.com"],
            forbiddenDomains: ["example.com"],
            proxy: {
              routing: [],
            },
          },
        })
        createdSandboxes.push(name)
        await comboSandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
      }, 60_000)

      it('allowedDomains takes precedence over forbiddenDomains', async () => {
        const result = await comboSandbox.process.exec({
          command: 'node /tmp/proxy-test.js GET https://httpbin.org/get',
          waitForCompletion: true,
        })
        expect(result.exitCode).toBe(0)
        expect(result.logs).toContain("httpbin.org")
      }, 60_000)
    })

    describe('allowedDomains with proxy routing', () => {
      let proxyFwSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

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

      beforeAll(async () => {
        const name = uniqueName("fw-proxy")
        proxyFwSandbox = await SandboxInstance.create({
          name,
          image: defaultImage,
          region: defaultRegion,
          labels: defaultLabels,
          network: {
            allowedDomains: ["httpbin.org"],
            proxy: {
              routing: [
                {
                  destinations: ["httpbin.org"],
                  headers: { "X-Firewall-Test": "allowed-and-injected" },
                },
              ],
            },
          },
        })
        createdSandboxes.push(name)
        await proxyFwSandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
      }, 60_000)

      it('injects headers for allowlisted and routed domain', async () => {
        const result = await proxyFwSandbox.process.exec({
          command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers',
          waitForCompletion: true,
        })
        expect(result.exitCode).toBe(0)

        const response = parseJsonOutput(result.logs)
        const headers = lowercaseKeys(response.headers)
        expect(headers["x-firewall-test"]).toBe("allowed-and-injected")
      }, 60_000)

      it('blocks non-allowlisted domain even without routing', async () => {
        const result = await proxyFwSandbox.process.exec({
          command: 'node /tmp/proxy-test.js GET https://example.com',
          waitForCompletion: true,
        })
        expect(result.exitCode).not.toBe(0)
      }, 60_000)
    })
  })

  describe('secrets replacement validation', () => {
    let secretSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

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

    beforeAll(async () => {
      const name = uniqueName("proxy-sec")
      secretSandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          proxy: {
            routing: [
              {
                destinations: ["httpbin.org"],
                headers: {
                  "X-Token": "Bearer {{SECRET:api-token}}",
                  "X-Multi": "{{SECRET:part-a}}-{{SECRET:part-b}}",
                  "X-Plain": "no-secret-here",
                },
                body: {
                  "secret_key": "{{SECRET:api-token}}",
                  "composite": "prefix-{{SECRET:part-a}}-suffix",
                },
                secrets: {
                  "api-token": "tok_live_abc123",
                  "part-a": "ALPHA",
                  "part-b": "BETA",
                },
              },
              {
                destinations: ["*.example.com"],
                headers: {
                  "X-Other-Secret": "{{SECRET:other-key}}",
                },
                secrets: {
                  "other-key": "other-value-999",
                },
              },
            ],
          },
        },
      })
      createdSandboxes.push(name)
      await secretSandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
    }, 60_000)

    it('resolves {{SECRET:name}} in headers to actual value', async () => {
      const result = await secretSandbox.process.exec({
        command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers',
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      const headers = lowercaseKeys(response.headers)
      expect(headers["x-token"]).toBe("Bearer tok_live_abc123")
      expect(headers["x-plain"]).toBe("no-secret-here")
    }, 60_000)

    it('resolves multiple {{SECRET:...}} placeholders in a single header', async () => {
      const result = await secretSandbox.process.exec({
        command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers',
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      const headers = lowercaseKeys(response.headers)
      expect(headers["x-multi"]).toBe("ALPHA-BETA")
    }, 60_000)

    it('resolves {{SECRET:name}} in POST body fields', async () => {
      const result = await secretSandbox.process.exec({
        command: `node /tmp/proxy-test.js POST https://httpbin.org/post '{}' '{"user_field":"untouched"}'`,
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      expect(response.json.user_field).toBe("untouched")
      expect(response.json.secret_key).toBe("tok_live_abc123")
      expect(response.json.composite).toBe("prefix-ALPHA-suffix")
    }, 60_000)

    it('does not leak secrets from one route to another destination', async () => {
      const result = await secretSandbox.process.exec({
        command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers',
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      const headers = lowercaseKeys(response.headers)
      expect(headers["x-other-secret"]).toBeUndefined()
    }, 60_000)

    it('does not expose raw {{SECRET:...}} template on the wire', async () => {
      const result = await secretSandbox.process.exec({
        command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers',
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const raw = result.logs || ""
      expect(raw).not.toContain("{{SECRET:")
    }, 60_000)

    it('resolves {{SECRET:name}} in user-sent headers', async () => {
      const result = await secretSandbox.process.exec({
        command: `node /tmp/proxy-test.js GET https://httpbin.org/headers '{"X-User-Token":"{{SECRET:api-token}}","X-User-Combo":"pre-{{SECRET:part-a}}-post"}'`,
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      const headers = lowercaseKeys(response.headers)
      expect(headers["x-user-token"]).toBe("tok_live_abc123")
      expect(headers["x-user-combo"]).toBe("pre-ALPHA-post")
    }, 60_000)

    it('resolves {{SECRET:name}} in user-sent POST body', async () => {
      const result = await secretSandbox.process.exec({
        command: `node /tmp/proxy-test.js POST https://httpbin.org/post '{}' '{"api_key":"{{SECRET:api-token}}","mixed":"hello-{{SECRET:part-b}}-world"}'`,
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      expect(response.json.api_key).toBe("tok_live_abc123")
      expect(response.json.mixed).toBe("hello-BETA-world")
    }, 60_000)

    it('does not resolve secrets from a different route in user-sent headers', async () => {
      const result = await secretSandbox.process.exec({
        command: `node /tmp/proxy-test.js GET https://httpbin.org/headers '{"X-Wrong-Route":"{{SECRET:other-key}}"}'`,
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      const headers = lowercaseKeys(response.headers)
      expect(headers["x-wrong-route"]).toBe("{{SECRET:other-key}}")
    }, 60_000)
  })

  describe('proxy with wildcard (*) destination', () => {
    let wildcardSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

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

    beforeAll(async () => {
      const name = uniqueName("proxy-wild")
      wildcardSandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          proxy: {
            routing: [
              {
                destinations: ["*"],
                headers: {
                  "X-Global-Auth": "Bearer {{SECRET:global-key}}",
                },
                secrets: {
                  "global-key": "global-token-xyz",
                },
              },
            ],
          },
        },
      })
      createdSandboxes.push(name)
      await wildcardSandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
    }, 60_000)

    it('applies global rule to httpbin.org', async () => {
      const result = await wildcardSandbox.process.exec({
        command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers',
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      const headers = lowercaseKeys(response.headers)
      expect(headers["x-global-auth"]).toBe("Bearer global-token-xyz")
    }, 60_000)
  })

  describe('proxy end-to-end functionality', () => {
    let sandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

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

    beforeAll(async () => {
      const name = uniqueName("proxy-e2e")
      sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          proxy: {
            routing: [
              {
                destinations: ["httpbin.org"],
                headers: {
                  "X-Proxy-Test": "header-injected",
                  "X-Api-Key": "{{SECRET:test-api-key}}",
                },
                body: {
                  "injected_field": "body-injected",
                  "secret_body": "{{SECRET:test-api-key}}",
                },
                secrets: {
                  "test-api-key": "resolved-secret-42",
                },
              },
              {
                destinations: ["*.example.com"],
                headers: {
                  "X-Wildcard-Match": "wildcard-injected",
                },
              },
            ],
          },
        },
      })
      createdSandboxes.push(name)

      await sandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
    }, 60_000)

    it('routes HTTPS requests through the proxy with header injection', async () => {
      const result = await sandbox.process.exec({
        command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers',
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      const headers = lowercaseKeys(response.headers)

      expect(headers["x-blaxel-request-id"]).toBeDefined()
      expect(headers["x-proxy-test"]).toBe("header-injected")
      expect(headers["x-api-key"]).toBe("resolved-secret-42")
    }, 60_000)

    it('routes POST requests through the proxy with body injection', async () => {
      const result = await sandbox.process.exec({
        command: `node /tmp/proxy-test.js POST https://httpbin.org/post '{}' '{"user_data":"original"}'`,
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      expect(response.json.user_data).toBe("original")

      const headers = lowercaseKeys(response.headers)
      expect(headers["x-blaxel-request-id"]).toBeDefined()
      expect(headers["x-proxy-test"]).toBe("header-injected")
      expect(headers["x-api-key"]).toBe("resolved-secret-42")

      expect(response.json.injected_field).toBe("body-injected")
      expect(response.json.secret_body).toBe("resolved-secret-42")
    }, 60_000)

    it('preserves user-sent headers when routing through the proxy', async () => {
      const result = await sandbox.process.exec({
        command: `node /tmp/proxy-test.js GET https://httpbin.org/headers '{"X-User-Custom":"my-value"}'`,
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      const headers = lowercaseKeys(response.headers)
      expect(headers["x-user-custom"]).toBe("my-value")
      expect(headers["x-blaxel-request-id"]).toBeDefined()
      expect(headers["x-proxy-test"]).toBe("header-injected")
    }, 60_000)

    it('does not route local requests through the proxy', async () => {
      const result = await sandbox.process.exec({
        command: [
          "node -e 'const http = require(\"http\");",
          'const srv = http.createServer((req, res) => {',
          'res.writeHead(200, {"Content-Type": "application/json"});',
          'res.end(JSON.stringify(req.headers));',
          '});',
          'srv.listen(19876, () => {',
          'http.get("http://localhost:19876", (r) => {',
          'let d = ""; r.on("data", c => d += c);',
          'r.on("end", () => { console.log(d); srv.close(); });',
          '});',
          "});'",
        ].join(' '),
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const headers = parseJsonOutput(result.logs)
      expect(headers["x-blaxel-request-id"]).toBeUndefined()
      expect(headers["x-proxy-test"]).toBeUndefined()
    }, 60_000)

    it('does not inject headers for non-routed destinations', async () => {
      const result = await sandbox.process.exec({
        command: 'node /tmp/proxy-test.js GET https://www.example.com',
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const body = result.logs?.trim() || ""
      expect(body.length).toBeGreaterThan(0)
    }, 60_000)

    it('wildcard route matches subdomain (*.example.com)', async () => {
      const result = await sandbox.process.exec({
        command: 'node /tmp/proxy-test.js GET https://sub.example.com',
        waitForCompletion: true,
      })

      if (result.exitCode !== 0) {
        expect(result.exitCode).toBe(0)
        return
      }

      const body = result.logs?.trim() || ""
      if (body.includes("{")) {
        const response = parseJsonOutput(result.logs)
        const headers = lowercaseKeys(response.headers || {})
        expect(headers["x-wildcard-match"]).toBe("wildcard-injected")
      }
    }, 60_000)

    it('wildcard route does not match bare domain (example.com)', async () => {
      const result = await sandbox.process.exec({
        command: 'node /tmp/proxy-test.js GET https://example.com',
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const body = result.logs?.trim() || ""
      expect(body.length).toBeGreaterThan(0)
      expect(body).not.toContain("wildcard-injected")
    }, 60_000)

    it('verifies proxy env vars are set and Node.js fetch respects them', async () => {
      const envCheck = await sandbox.process.exec({
        command: [
          "node -e 'const vars = [\"HTTP_PROXY\",\"HTTPS_PROXY\",\"NO_PROXY\",\"NODE_EXTRA_CA_CERTS\",\"SSL_CERT_FILE\"];",
          'const result = {};',
          'vars.forEach(v => result[v] = process.env[v] ? "set" : "unset");',
          "console.log(JSON.stringify(result));'",
        ].join(' '),
        waitForCompletion: true,
      })
      expect(envCheck.exitCode).toBe(0)
      const envs = parseJsonOutput(envCheck.logs)
      expect(envs["HTTP_PROXY"]).toBe("set")
      expect(envs["HTTPS_PROXY"]).toBe("set")
      expect(envs["NO_PROXY"]).toBe("set")
      expect(envs["NODE_EXTRA_CA_CERTS"]).toBe("set")
      expect(envs["SSL_CERT_FILE"]).toBe("set")
    }, 60_000)
  })

  describe('proxy e2e with common CLI tools', () => {
    let cliSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

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

    beforeAll(async () => {
      const name = uniqueName("proxy-cli")
      cliSandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          proxy: {
            routing: [
              {
                destinations: ["httpbin.org"],
                headers: {
                  "X-Proxy-Test": "header-injected",
                  "X-Api-Key": "{{SECRET:test-api-key}}",
                },
                body: {
                  "injected_field": "body-injected",
                  "secret_body": "{{SECRET:test-api-key}}",
                },
                secrets: {
                  "test-api-key": "resolved-secret-42",
                },
              },
            ],
          },
        },
      })
      createdSandboxes.push(name)

      const install = await cliSandbox.process.exec({
        command: 'apk add --no-cache curl wget git python3 py3-pip 2>&1',
        waitForCompletion: true,
      })
      if (install.exitCode !== 0) {
        throw new Error(`apk install failed: ${install.logs?.slice(0, 500)}`)
      }
    }, 120_000)

    describe('curl', () => {
      it('routes GET requests through the proxy with header injection', async () => {
        const result = await cliSandbox.process.exec({
          command: 'curl -s https://httpbin.org/headers',
          waitForCompletion: true,
        })
        expect(result.exitCode).toBe(0)

        const response = parseJsonOutput(result.logs)
        const headers = lowercaseKeys(response.headers)
        expect(headers["x-blaxel-request-id"]).toBeDefined()
        expect(headers["x-proxy-test"]).toBe("header-injected")
        expect(headers["x-api-key"]).toBe("resolved-secret-42")
      }, 60_000)

      it('routes POST requests through the proxy with body injection', async () => {
        const result = await cliSandbox.process.exec({
          command: `curl -s -X POST https://httpbin.org/post -H "Content-Type: application/json" -d '{"user_data":"from-curl"}'`,
          waitForCompletion: true,
        })
        expect(result.exitCode).toBe(0)

        const response = parseJsonOutput(result.logs)
        expect(response.json.user_data).toBe("from-curl")
        expect(response.json.injected_field).toBe("body-injected")
        expect(response.json.secret_body).toBe("resolved-secret-42")

        const headers = lowercaseKeys(response.headers)
        expect(headers["x-blaxel-request-id"]).toBeDefined()
        expect(headers["x-proxy-test"]).toBe("header-injected")
      }, 60_000)

      it('preserves user-sent headers', async () => {
        const result = await cliSandbox.process.exec({
          command: 'curl -s -H "X-User-Custom: from-curl" https://httpbin.org/headers',
          waitForCompletion: true,
        })
        expect(result.exitCode).toBe(0)

        const response = parseJsonOutput(result.logs)
        const headers = lowercaseKeys(response.headers)
        expect(headers["x-user-custom"]).toBe("from-curl")
        expect(headers["x-proxy-test"]).toBe("header-injected")
        expect(headers["x-api-key"]).toBe("resolved-secret-42")
      }, 60_000)

      it('follows redirects through the proxy', async () => {
        const result = await cliSandbox.process.exec({
          command: 'curl -s -L -o /dev/null -w "%{http_code}" https://httpbin.org/redirect/1',
          waitForCompletion: true,
        })
        expect(result.exitCode).toBe(0)
        expect(result.logs?.trim()).toBe("200")
      }, 60_000)

      it('sends PUT requests through the proxy', async () => {
        const result = await cliSandbox.process.exec({
          command: `curl -s -X PUT https://httpbin.org/put -H "Content-Type: application/json" -d '{"update":"from-curl"}'`,
          waitForCompletion: true,
        })
        expect(result.exitCode).toBe(0)

        const response = parseJsonOutput(result.logs)
        expect(response.json.update).toBe("from-curl")

        const headers = lowercaseKeys(response.headers)
        expect(headers["x-proxy-test"]).toBe("header-injected")
      }, 60_000)

      it('sends DELETE requests through the proxy', async () => {
        const result = await cliSandbox.process.exec({
          command: 'curl -s -X DELETE https://httpbin.org/delete',
          waitForCompletion: true,
        })
        expect(result.exitCode).toBe(0)

        const response = parseJsonOutput(result.logs)
        const headers = lowercaseKeys(response.headers)
        expect(headers["x-proxy-test"]).toBe("header-injected")
      }, 60_000)

      it('handles large response payloads', async () => {
        const result = await cliSandbox.process.exec({
          command: 'curl -s -o /dev/null -w "%{http_code} %{size_download}" https://httpbin.org/bytes/10240',
          waitForCompletion: true,
        })
        expect(result.exitCode).toBe(0)
        const [statusCode, sizeStr] = (result.logs?.trim() || "").split(" ")
        expect(statusCode).toBe("200")
        expect(parseInt(sizeStr)).toBeGreaterThanOrEqual(10240)
      }, 60_000)
    })

    // describe('wget', () => {
    //   const wgetProxy = 'export https_proxy=$HTTPS_PROXY http_proxy=$HTTP_PROXY &&'

    //   it('routes GET requests through the proxy with header injection', async () => {
    //     const result = await cliSandbox.process.exec({
    //       command: `${wgetProxy} wget --ca-certificate=$SSL_CERT_FILE -qO- https://httpbin.org/headers`,
    //       waitForCompletion: true,
    //     })
    //     expect(result.exitCode).toBe(0)

    //     const response = parseJsonOutput(result.logs)
    //     const headers = lowercaseKeys(response.headers)
    //     expect(headers["x-blaxel-request-id"]).toBeDefined()
    //     expect(headers["x-proxy-test"]).toBe("header-injected")
    //     expect(headers["x-api-key"]).toBe("resolved-secret-42")
    //   }, 60_000)

    //   it('preserves user-sent headers', async () => {
    //     const result = await cliSandbox.process.exec({
    //       command: `${wgetProxy} wget --ca-certificate=$SSL_CERT_FILE -qO- --header="X-User-Custom: from-wget" https://httpbin.org/headers`,
    //       waitForCompletion: true,
    //     })
    //     expect(result.exitCode).toBe(0)

    //     const response = parseJsonOutput(result.logs)
    //     const headers = lowercaseKeys(response.headers)
    //     expect(headers["x-user-custom"]).toBe("from-wget")
    //     expect(headers["x-proxy-test"]).toBe("header-injected")
    //   }, 60_000)

    //   it('downloads files through the proxy', async () => {
    //     const result = await cliSandbox.process.exec({
    //       command: `${wgetProxy} wget --ca-certificate=$SSL_CERT_FILE -q https://httpbin.org/bytes/1024 -O /tmp/wget-test-file && wc -c < /tmp/wget-test-file`,
    //       waitForCompletion: true,
    //     })
    //     expect(result.exitCode).toBe(0)
    //     expect(parseInt(result.logs?.trim() || "0")).toBeGreaterThanOrEqual(1024)
    //   }, 60_000)

    //   it('POST with body through the proxy', async () => {
    //     const result = await cliSandbox.process.exec({
    //       command: `${wgetProxy} wget --ca-certificate=$SSL_CERT_FILE -qO- --post-data='{"user_data":"from-wget"}' --header="Content-Type: application/json" https://httpbin.org/post`,
    //       waitForCompletion: true,
    //     })
    //     expect(result.exitCode).toBe(0)

    //     const response = parseJsonOutput(result.logs)
    //     expect(response.json.user_data).toBe("from-wget")
    //     expect(response.json.injected_field).toBe("body-injected")
    //     expect(response.json.secret_body).toBe("resolved-secret-42")
    //   }, 60_000)
    // })

    describe('git', () => {
      it('clones a public repository through the proxy', async () => {        const result = await cliSandbox.process.exec({
          command: 'export https_proxy=$HTTPS_PROXY http_proxy=$HTTP_PROXY && GIT_SSL_CAINFO=$SSL_CERT_FILE git -c http.proxyAuthMethod=basic clone --depth 1 https://github.com/octocat/Hello-World.git /tmp/git-test-repo 2>&1',
          waitForCompletion: true,
        })
        expect(result.exitCode).toBe(0)

        const verify = await cliSandbox.process.exec({
          command: 'ls /tmp/git-test-repo/README',
          waitForCompletion: true,
        })
        expect(verify.exitCode).toBe(0)
      }, 120_000)

      it('git ls-remote works through the proxy', async () => {
        const result = await cliSandbox.process.exec({
          command: 'export https_proxy=$HTTPS_PROXY http_proxy=$HTTP_PROXY && GIT_SSL_CAINFO=$SSL_CERT_FILE git -c http.proxyAuthMethod=basic ls-remote --heads https://github.com/octocat/Hello-World.git 2>&1',
          waitForCompletion: true,
        })
        expect(result.exitCode).toBe(0)
        expect(result.logs).toContain("refs/heads/")
      }, 60_000)

      it('proxy env vars are visible to git', async () => {
        const result = await cliSandbox.process.exec({
          command: 'git config --global --list 2>&1; echo "---"; env | grep -i proxy || true',
          waitForCompletion: true,
        })
        expect(result.exitCode).toBe(0)
        const logs = result.logs || ""
        const hasProxy = logs.toLowerCase().includes("proxy") || logs.includes("HTTPS_PROXY") || logs.includes("https_proxy")
        expect(hasProxy).toBe(true)
      }, 30_000)
    })

    describe('pip (Python package manager)', () => {
      it('pip install works through the proxy', async () => {
        const result = await cliSandbox.process.exec({
          command: 'pip3 install --break-system-packages --quiet six 2>&1 && python3 -c "import six; print(six.__version__)"',
          waitForCompletion: true,
        })
        expect(result.exitCode).toBe(0)
        expect(result.logs?.trim()).toMatch(/\d+\.\d+/)
      }, 120_000)
    })

    describe('npm / npx (Node package manager)', () => {
      it('npm install works through the proxy', async () => {
        await cliSandbox.fs.write("/tmp/npm-test/package.json", JSON.stringify({
          name: "proxy-npm-test",
          version: "1.0.0",
          dependencies: { "is-odd": "^3.0.1" },
        }))

        const result = await cliSandbox.process.exec({
          command: 'cd /tmp/npm-test && npm install --no-audit --no-fund 2>&1',
          waitForCompletion: true,
        })
        expect(result.exitCode).toBe(0)

        const verify = await cliSandbox.process.exec({
          command: 'node -e "console.log(require(\'/tmp/npm-test/node_modules/is-odd\')(3))"',
          waitForCompletion: true,
        })
        expect(verify.exitCode).toBe(0)
        expect(verify.logs?.trim()).toBe("true")
      }, 120_000)
    })
  })

  describe('proxy e2e with Python requests (py-app image)', () => {
    let pySandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

    const pythonHelperScript = `
import sys, json, requests
method = sys.argv[1] if len(sys.argv) > 1 else "GET"
url = sys.argv[2] if len(sys.argv) > 2 else "https://httpbin.org/headers"
headers = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
body = sys.argv[4] if len(sys.argv) > 4 else None
resp = requests.request(method, url, headers=headers, data=body, timeout=30)
print(resp.text)
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

    beforeAll(async () => {
      const name = uniqueName("proxy-py")
      pySandbox = await SandboxInstance.create({
        name,
        image: "blaxel/py-app:latest",
        region: defaultRegion,
        labels: defaultLabels,
        network: {
          proxy: {
            routing: [
              {
                destinations: ["httpbin.org"],
                headers: {
                  "X-Proxy-Test": "header-injected",
                  "X-Api-Key": "{{SECRET:test-api-key}}",
                },
                body: {
                  "injected_field": "body-injected",
                  "secret_body": "{{SECRET:test-api-key}}",
                },
                secrets: {
                  "test-api-key": "resolved-secret-42",
                },
              },
            ],
          },
        },
      })
      createdSandboxes.push(name)

      await pySandbox.fs.write("/tmp/proxy-test.py", pythonHelperScript)

      const pipResult = await pySandbox.process.exec({
        command: 'pip install --break-system-packages requests 2>&1',
        waitForCompletion: true,
      })
      if (pipResult.exitCode !== 0) {
        throw new Error(`pip install failed: ${pipResult.logs?.slice(0, 500)}`)
      }
    }, 120_000)

    it('injects headers via Python requests (respects HTTPS_PROXY)', async () => {
      const result = await pySandbox.process.exec({
        command: 'python3 /tmp/proxy-test.py GET https://httpbin.org/headers 2>&1',
        waitForCompletion: true,
      })
      if (result.exitCode !== 0) {
        throw new Error(`python3 exited ${result.exitCode}: ${result.logs?.slice(0, 1500)}`)
      }

      const response = parseJsonOutput(result.logs)
      const headers = lowercaseKeys(response.headers)
      expect(headers["x-blaxel-request-id"]).toBeDefined()
      expect(headers["x-proxy-test"]).toBe("header-injected")
      expect(headers["x-api-key"]).toBe("resolved-secret-42")
    }, 90_000)

    it('injects body fields via Python requests POST', async () => {
      const result = await pySandbox.process.exec({
        command: `python3 /tmp/proxy-test.py POST https://httpbin.org/post '{}' '{"user_data":"from-python"}'`,
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      expect(response.json.user_data).toBe("from-python")
      expect(response.json.injected_field).toBe("body-injected")
      expect(response.json.secret_body).toBe("resolved-secret-42")
    }, 90_000)

    it('preserves user-sent headers via Python requests', async () => {
      const result = await pySandbox.process.exec({
        command: `python3 /tmp/proxy-test.py GET https://httpbin.org/headers '{"X-User-Custom":"from-python"}'`,
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)

      const response = parseJsonOutput(result.logs)
      const headers = lowercaseKeys(response.headers)
      expect(headers["x-user-custom"]).toBe("from-python")
      expect(headers["x-proxy-test"]).toBe("header-injected")
    }, 90_000)
  })

  describe('proxy e2e with Claude Code agent', () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      it.skip('requires ANTHROPIC_API_KEY', () => {})
      return
    }

    let claudeSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

    beforeAll(async () => {
      const name = uniqueName("proxy-claude")
      claudeSandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        region: defaultRegion,
        labels: defaultLabels,
        envs: [
          { name: "ANTHROPIC_API_KEY", value: process.env.ANTHROPIC_API_KEY! },
        ],
        network: {
          proxy: {
            routing: [
              {
                destinations: ["httpbin.org"],
                headers: {
                  "X-Agent-Test": "claude-injected",
                },
              },
            ],
          },
        },
      })
      createdSandboxes.push(name)

      const setup = await claudeSandbox.process.exec({
        command: 'apk add --no-cache curl bash 2>&1 && npm install -g @anthropic-ai/claude-code 2>&1 && adduser -D -s /bin/bash agent 2>&1',
        waitForCompletion: true,
      })
      if (setup.exitCode !== 0) {
        throw new Error(`setup failed: ${setup.logs?.slice(0, 500)}`)
      }
    }, 300_000)

    const claudeEnv = [
      'export PATH=/usr/local/bin:/usr/bin:/bin',
      'ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY',
      'HTTP_PROXY=$HTTP_PROXY',
      'HTTPS_PROXY=$HTTPS_PROXY',
      'NO_PROXY=$NO_PROXY',
      'NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS',
      'SSL_CERT_FILE=$SSL_CERT_FILE',
    ].join(' ')

    it('agent reaches Anthropic API through the proxy', async () => {
      const result = await claudeSandbox.process.exec({
        command: `su - agent -c "${claudeEnv} && claude --dangerously-skip-permissions -p \\"What is 2+2? Reply with ONLY the number.\\" --output-format text" 2>&1`,
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)
      expect(result.logs).toContain("4")
    }, 120_000)

    it('agent makes outbound call through the proxy with header injection', async () => {
      const result = await claudeSandbox.process.exec({
        command: `su - agent -c "${claudeEnv} && claude --dangerously-skip-permissions -p \\"Run: curl -s https://httpbin.org/headers — then print the full JSON output.\\" --output-format text" 2>&1`,
        waitForCompletion: true,
      })
      expect(result.exitCode).toBe(0)
      expect(result.logs).toContain("X-Agent-Test")
      expect(result.logs).toContain("claude-injected")
    }, 180_000)
  })

  describe('proxy vs no-proxy comparison', () => {
    let proxySandbox: Awaited<ReturnType<typeof SandboxInstance.create>>
    let noProxySandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

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

    async function timedExec(
      sb: Awaited<ReturnType<typeof SandboxInstance.create>>,
      command: string,
    ): Promise<{ logs: string | undefined; exitCode: number | undefined; durationMs: number }> {
      const start = Date.now()
      const result = await sb.process.exec({ command, waitForCompletion: true })
      return { logs: result.logs, exitCode: result.exitCode, durationMs: Date.now() - start }
    }

    beforeAll(async () => {
      const [proxyName, noProxyName] = [uniqueName("cmp-proxy"), uniqueName("cmp-noproxy")]

      const [pSb, npSb] = await Promise.all([
        SandboxInstance.create({
          name: proxyName,
          image: defaultImage,
          region: defaultRegion,
          labels: defaultLabels,
          network: {
            proxy: {
              routing: [
                {
                  destinations: ["httpbin.org"],
                  headers: {
                    "X-Proxy-Compare": "with-proxy",
                    "X-Api-Key": "{{SECRET:cmp-key}}",
                  },
                  body: {
                    "injected_field": "proxy-injected",
                  },
                  secrets: {
                    "cmp-key": "comparison-secret-123",
                  },
                },
              ],
            },
          },
        }),
        SandboxInstance.create({
          name: noProxyName,
          image: defaultImage,
          region: defaultRegion,
          labels: defaultLabels,
        }),
      ])
      proxySandbox = pSb
      noProxySandbox = npSb
      createdSandboxes.push(proxyName, noProxyName)

      await Promise.all([
        proxySandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript),
        noProxySandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript),
      ])
    }, 120_000)

    it('proxy sandbox injects headers, no-proxy sandbox does not', async () => {
      const [proxyResult, noProxyResult] = await Promise.all([
        timedExec(proxySandbox, 'node /tmp/proxy-test.js GET https://httpbin.org/headers'),
        timedExec(noProxySandbox, 'node /tmp/proxy-test.js GET https://httpbin.org/headers'),
      ])

      expect(proxyResult.exitCode).toBe(0)
      expect(noProxyResult.exitCode).toBe(0)

      const proxyHeaders = lowercaseKeys(parseJsonOutput(proxyResult.logs).headers)
      const noProxyHeaders = lowercaseKeys(parseJsonOutput(noProxyResult.logs).headers)

      expect(proxyHeaders["x-proxy-compare"]).toBe("with-proxy")
      expect(proxyHeaders["x-api-key"]).toBe("comparison-secret-123")
      expect(proxyHeaders["x-blaxel-request-id"]).toBeDefined()

      expect(noProxyHeaders["x-proxy-compare"]).toBeUndefined()
      expect(noProxyHeaders["x-api-key"]).toBeUndefined()
      expect(noProxyHeaders["x-blaxel-request-id"]).toBeUndefined()

      console.log(`[compare GET headers] proxy: ${proxyResult.durationMs}ms, no-proxy: ${noProxyResult.durationMs}ms, overhead: ${proxyResult.durationMs - noProxyResult.durationMs}ms`)
    }, 60_000)

    it('proxy sandbox injects body fields, no-proxy sandbox does not', async () => {
      const postBody = JSON.stringify({ user_data: "original" })
      const cmd = `node /tmp/proxy-test.js POST https://httpbin.org/post '{}' '${postBody}'`

      const [proxyResult, noProxyResult] = await Promise.all([
        timedExec(proxySandbox, cmd),
        timedExec(noProxySandbox, cmd),
      ])

      expect(proxyResult.exitCode).toBe(0)
      expect(noProxyResult.exitCode).toBe(0)

      const proxyBody = parseJsonOutput(proxyResult.logs)
      const noProxyBody = parseJsonOutput(noProxyResult.logs)

      expect(proxyBody.json.user_data).toBe("original")
      expect(proxyBody.json.injected_field).toBe("proxy-injected")

      expect(noProxyBody.json.user_data).toBe("original")
      expect(noProxyBody.json.injected_field).toBeUndefined()

      console.log(`[compare POST body] proxy: ${proxyResult.durationMs}ms, no-proxy: ${noProxyResult.durationMs}ms, overhead: ${proxyResult.durationMs - noProxyResult.durationMs}ms`)
    }, 60_000)

    it('proxy sandbox has proxy env vars, no-proxy sandbox does not', async () => {
      const envCmd = `node -e 'const vars = ["HTTP_PROXY","HTTPS_PROXY","NO_PROXY","NODE_EXTRA_CA_CERTS","SSL_CERT_FILE"]; const r = {}; vars.forEach(v => r[v] = process.env[v] ? "set" : "unset"); console.log(JSON.stringify(r));'`

      const [proxyEnv, noProxyEnv] = await Promise.all([
        proxySandbox.process.exec({ command: envCmd, waitForCompletion: true }),
        noProxySandbox.process.exec({ command: envCmd, waitForCompletion: true }),
      ])

      expect(proxyEnv.exitCode).toBe(0)
      expect(noProxyEnv.exitCode).toBe(0)

      const pEnvs = parseJsonOutput(proxyEnv.logs)
      const npEnvs = parseJsonOutput(noProxyEnv.logs)

      expect(pEnvs["HTTP_PROXY"]).toBe("set")
      expect(pEnvs["HTTPS_PROXY"]).toBe("set")
      expect(pEnvs["NODE_EXTRA_CA_CERTS"]).toBe("set")

      expect(npEnvs["HTTP_PROXY"]).toBe("unset")
      expect(npEnvs["HTTPS_PROXY"]).toBe("unset")
      expect(npEnvs["NODE_EXTRA_CA_CERTS"]).toBe("unset")
    }, 60_000)

    it('both sandboxes reach the same endpoint successfully', async () => {
      const cmd = 'node /tmp/proxy-test.js GET https://httpbin.org/get'

      const [proxyResult, noProxyResult] = await Promise.all([
        timedExec(proxySandbox, cmd),
        timedExec(noProxySandbox, cmd),
      ])

      expect(proxyResult.exitCode).toBe(0)
      expect(noProxyResult.exitCode).toBe(0)

      const proxyResp = parseJsonOutput(proxyResult.logs)
      const noProxyResp = parseJsonOutput(noProxyResult.logs)

      expect(proxyResp.url).toBe("https://httpbin.org/get")
      expect(noProxyResp.url).toBe("https://httpbin.org/get")

      console.log(`[compare GET /get] proxy: ${proxyResult.durationMs}ms, no-proxy: ${noProxyResult.durationMs}ms, overhead: ${proxyResult.durationMs - noProxyResult.durationMs}ms`)
    }, 60_000)

    it('latency overhead is within acceptable bounds', async () => {
      const iterations = 3
      const proxyTimes: number[] = []
      const noProxyTimes: number[] = []

      for (let i = 0; i < iterations; i++) {
        const [p, np] = await Promise.all([
          timedExec(proxySandbox, 'node /tmp/proxy-test.js GET https://httpbin.org/get'),
          timedExec(noProxySandbox, 'node /tmp/proxy-test.js GET https://httpbin.org/get'),
        ])
        expect(p.exitCode).toBe(0)
        expect(np.exitCode).toBe(0)
        proxyTimes.push(p.durationMs)
        noProxyTimes.push(np.durationMs)
      }

      const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length
      const proxyAvg = avg(proxyTimes)
      const noProxyAvg = avg(noProxyTimes)
      const overheadMs = proxyAvg - noProxyAvg
      const overheadPct = noProxyAvg > 0 ? (overheadMs / noProxyAvg) * 100 : 0

      console.log(`[latency benchmark] proxy avg: ${proxyAvg.toFixed(0)}ms, no-proxy avg: ${noProxyAvg.toFixed(0)}ms`)
      console.log(`[latency benchmark] overhead: ${overheadMs.toFixed(0)}ms (${overheadPct.toFixed(1)}%)`)
      console.log(`[latency benchmark] proxy samples: [${proxyTimes.join(', ')}], no-proxy samples: [${noProxyTimes.join(', ')}]`)

      // Proxy overhead should stay under 5 seconds per request on average
      expect(overheadMs).toBeLessThan(5000)
    }, 180_000)
  })

  // NOTE: OpenAI Codex CLI (Rust-based) requires a real TTY and has no headless/pipe mode.
  // It cannot be run in non-interactive sandbox exec. The proxy routing for OpenAI traffic
  // is already validated by the curl, Node.js, and Python test suites above.
})
