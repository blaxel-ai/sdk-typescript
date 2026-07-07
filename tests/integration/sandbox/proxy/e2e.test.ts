import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName, isUsingMk3_1 } from '../helpers.js'
import { createEchoServerSandbox, createReadyProxySandbox, execProxyCommandWithRetry, lowercaseKeys, parseJsonObjectOutput, proxyCleanup } from './helpers.js'

type HttpBinResponse = {
  headers: Record<string, string>
  json: Record<string, unknown>
}

describe.skipIf(isUsingMk3_1())('proxy end-to-end functionality', () => {
  const createdSandboxes: string[] = []
  afterAll(proxyCleanup(createdSandboxes))

  let sandbox: Awaited<ReturnType<typeof SandboxInstance.create>>
  // Controlled httpbin-compatible upstream reached via a preview URL, replacing
  // the flaky public httpbin.org.
  let headersUrl: string
  let postUrl: string

  beforeAll(async () => {
    const echo = await createEchoServerSandbox(createdSandboxes)
    headersUrl = `${echo.url}/headers`
    postUrl = `${echo.url}/post`
    // The echo host is `<label>.<parent>`. A `*.<parent>` route therefore matches
    // it as a subdomain (exercises wildcard-subdomain matching + injection), while
    // a `*.<host>` route must NOT match it (proves a wildcard doesn't match its own
    // bare domain).
    const parentDomain = echo.host.split(".").slice(1).join(".")

    sandbox = await createReadyProxySandbox(
      async () => {
        const name = uniqueName("proxy-e2e")
        const sandbox = await SandboxInstance.create({
          name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
          network: {
            proxy: {
              routing: [
                {
                  destinations: [`*.${parentDomain}`],
                  headers: { "X-Proxy-Test": "header-injected", "X-Api-Key": "{{SECRET:test-api-key}}", "X-Wildcard-Match": "wildcard-injected" },
                  body: { "injected_field": "body-injected", "secret_body": "{{SECRET:test-api-key}}" },
                  secrets: { "test-api-key": "resolved-secret-42" },
                },
                {
                  destinations: [`*.${echo.host}`],
                  headers: { "X-Wildcard-Sub": "should-not-match-bare" },
                },
              ],
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
        return headers["x-proxy-test"] === "header-injected" && headers["x-api-key"] === "resolved-secret-42"
      },
    )
  }, 240_000)

  it('routes HTTPS requests through the proxy with header injection', async () => {
    const result = await execProxyCommandWithRetry(sandbox, `node /tmp/proxy-test.js GET ${headersUrl}`)
    expect(result.exitCode, result.logs).toBe(0)
    const headers = lowercaseKeys(parseJsonObjectOutput<HttpBinResponse>(result.logs).headers)
    expect(headers["x-proxy-test"]).toBe("header-injected")
    expect(headers["x-api-key"]).toBe("resolved-secret-42")
  }, 60_000)

  it('routes POST requests through the proxy with body injection', async () => {
    const result = await execProxyCommandWithRetry(sandbox, `node /tmp/proxy-test.js POST ${postUrl} '{}' '{"user_data":"original"}'`)
    expect(result.exitCode, result.logs).toBe(0)
    const response = parseJsonObjectOutput<HttpBinResponse>(result.logs)
    expect(response.json.user_data).toBe("original")
    const headers = lowercaseKeys(response.headers)
    expect(headers["x-proxy-test"]).toBe("header-injected")
    expect(headers["x-api-key"]).toBe("resolved-secret-42")
    expect(response.json.injected_field).toBe("body-injected")
    expect(response.json.secret_body).toBe("resolved-secret-42")
  }, 60_000)

  it('preserves user-sent headers when routing through the proxy', async () => {
    const result = await execProxyCommandWithRetry(sandbox, `node /tmp/proxy-test.js GET ${headersUrl} '{"X-User-Custom":"my-value"}'`)
    expect(result.exitCode, result.logs).toBe(0)
    const headers = lowercaseKeys(parseJsonObjectOutput<HttpBinResponse>(result.logs).headers)
    expect(headers["x-user-custom"]).toBe("my-value")
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
    const headers = parseJsonObjectOutput<Record<string, string>>(result.logs)
    expect(headers["x-blaxel-request-id"]).toBeUndefined()
    expect(headers["x-proxy-test"]).toBeUndefined()
  }, 60_000)

  it('does not inject headers for non-routed destinations', async () => {
    const result = await execProxyCommandWithRetry(sandbox, 'node /tmp/proxy-test.js GET https://www.google.com')
    expect(result.exitCode, result.logs).toBe(0)
    expect((result.logs?.trim() || "").length).toBeGreaterThan(0)
  }, 60_000)

  it('wildcard route matches subdomain (*.<parent>)', async () => {
    const result = await execProxyCommandWithRetry(sandbox, `node /tmp/proxy-test.js GET ${headersUrl}`)
    expect(result.exitCode, result.logs).toBe(0)
    const headers = lowercaseKeys(parseJsonObjectOutput<HttpBinResponse>(result.logs).headers)
    expect(headers["x-wildcard-match"]).toBe("wildcard-injected")
  }, 60_000)

  it('wildcard route does not match its own bare domain (*.<host> vs <host>)', async () => {
    const result = await execProxyCommandWithRetry(sandbox, `node /tmp/proxy-test.js GET ${headersUrl}`)
    expect(result.exitCode, result.logs).toBe(0)
    const headers = lowercaseKeys(parseJsonObjectOutput<HttpBinResponse>(result.logs).headers)
    expect(headers["x-wildcard-sub"]).toBeUndefined()
  }, 60_000)

  it('verifies proxy env vars are set and Node.js fetch respects them', async () => {
    const envCheck = await sandbox.process.exec({
      command: `node -e 'const vars = ["HTTP_PROXY","HTTPS_PROXY","NO_PROXY","NODE_EXTRA_CA_CERTS","SSL_CERT_FILE"]; const result = {}; vars.forEach(v => result[v] = process.env[v] ? "set" : "unset"); console.log(JSON.stringify(result));'`,
      waitForCompletion: true,
    })
    expect(envCheck.exitCode).toBe(0)
    const envs = parseJsonObjectOutput<Record<string, string>>(envCheck.logs)
    expect(envs["HTTP_PROXY"]).toBe("set")
    expect(envs["HTTPS_PROXY"]).toBe("set")
    expect(envs["NO_PROXY"]).toBe("set")
    expect(envs["NODE_EXTRA_CA_CERTS"]).toBe("set")
    expect(envs["SSL_CERT_FILE"]).toBe("set")
  }, 60_000)
})
