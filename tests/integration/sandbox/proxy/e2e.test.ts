import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, sleep, uniqueName } from '../helpers.js'
import { lowercaseKeys, parseJsonOutput, proxyCleanup, proxyHelperScript } from './helpers.js'

describe('proxy end-to-end functionality', () => {
  const createdSandboxes: string[] = []
  afterAll(proxyCleanup(createdSandboxes))

  let sandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

  beforeAll(async () => {
    const name = uniqueName("proxy-e2e")
    sandbox = await SandboxInstance.create({
      name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
      network: {
        proxy: {
          routing: [
            {
              destinations: ["httpbin.org"],
              headers: { "X-Proxy-Test": "header-injected", "X-Api-Key": "{{SECRET:test-api-key}}" },
              body: { "injected_field": "body-injected", "secret_body": "{{SECRET:test-api-key}}" },
              secrets: { "test-api-key": "resolved-secret-42" },
            },
            {
              destinations: ["*.httpbin.org"],
              headers: { "X-Wildcard-Match": "wildcard-injected" },
            },
          ],
        },
      },
    })

    createdSandboxes.push(name)
    await sandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
  }, 60_000)

  it('routes HTTPS requests through the proxy with header injection', async () => {
    const result = await sandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers', waitForCompletion: true })
    expect(result.exitCode).toBe(0)
    const headers = lowercaseKeys(parseJsonOutput(result.logs).headers)
    expect(headers["x-blaxel-request-id"]).toBeDefined()
    expect(headers["x-proxy-test"]).toBe("header-injected")
    expect(headers["x-api-key"]).toBe("resolved-secret-42")
  }, 60_000)

  it('routes POST requests through the proxy with body injection', async () => {
    const result = await sandbox.process.exec({ command: `node /tmp/proxy-test.js POST https://httpbin.org/post '{}' '{"user_data":"original"}'`, waitForCompletion: true })
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
    const result = await sandbox.process.exec({ command: `node /tmp/proxy-test.js GET https://httpbin.org/headers '{"X-User-Custom":"my-value"}'`, waitForCompletion: true })
    expect(result.exitCode).toBe(0)
    const headers = lowercaseKeys(parseJsonOutput(result.logs).headers)
    expect(headers["x-user-custom"]).toBe("my-value")
    expect(headers["x-blaxel-request-id"]).toBeDefined()
    expect(headers["x-proxy-test"]).toBe("header-injected")
  }, 60_000)

  it('does not route local requests through the proxy', async () => {
    const result = await sandbox.process.exec({
      command: [
        "node -e 'const http = require(\"http\");",
        'const srv = http.createServer((req, res) => { res.writeHead(200, {"Content-Type": "application/json"}); res.end(JSON.stringify(req.headers)); });',
        'srv.listen(19876, () => { http.get("http://localhost:19876", (r) => { let d = ""; r.on("data", c => d += c); r.on("end", () => { console.log(d); srv.close(); }); }); });\'',
      ].join(' '),
      waitForCompletion: true,
    })
    expect(result.exitCode).toBe(0)
    const headers = parseJsonOutput(result.logs)
    expect(headers["x-blaxel-request-id"]).toBeUndefined()
    expect(headers["x-proxy-test"]).toBeUndefined()
  }, 60_000)

  it('does not inject headers for non-routed destinations', async () => {
    const result = await sandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://www.google.com', waitForCompletion: true })
    expect(result.exitCode).toBe(0)
    expect((result.logs?.trim() || "").length).toBeGreaterThan(0)
  }, 60_000)

  it('wildcard route matches subdomain (*.httpbin.org)', async () => {
    const result = await sandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://beta.httpbin.org/headers', waitForCompletion: true })
    expect(result.exitCode).toBe(0)
    const headers = lowercaseKeys(parseJsonOutput(result.logs).headers)
    expect(headers["x-wildcard-match"]).toBe("wildcard-injected")
  }, 60_000)

  it('wildcard route does not match bare domain (httpbin.org)', async () => {
    const result = await sandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers', waitForCompletion: true })
    expect(result.exitCode).toBe(0)
    const headers = lowercaseKeys(parseJsonOutput(result.logs).headers)
    expect(headers["x-wildcard-match"]).toBeUndefined()
  }, 60_000)

  it('verifies proxy env vars are set and Node.js fetch respects them', async () => {
    const envCheck = await sandbox.process.exec({
      command: `node -e 'const vars = ["HTTP_PROXY","HTTPS_PROXY","NO_PROXY","NODE_EXTRA_CA_CERTS","SSL_CERT_FILE"]; const result = {}; vars.forEach(v => result[v] = process.env[v] ? "set" : "unset"); console.log(JSON.stringify(result));'`,
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
