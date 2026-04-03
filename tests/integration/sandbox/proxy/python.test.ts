import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from '../helpers.js'
import { lowercaseKeys, parseJsonOutput, proxyCleanup } from './helpers.js'

describe('proxy e2e with Python requests (py-app image)', () => {
  const createdSandboxes: string[] = []
  afterAll(proxyCleanup(createdSandboxes))

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

  beforeAll(async () => {
    const name = uniqueName("proxy-py")
    pySandbox = await SandboxInstance.create({
      name, image: "blaxel/py-app:latest", region: defaultRegion, labels: defaultLabels,
      network: {
        proxy: {
          routing: [{
            destinations: ["httpbin.org"],
            headers: { "X-Proxy-Test": "header-injected", "X-Api-Key": "{{SECRET:test-api-key}}" },
            body: { "injected_field": "body-injected", "secret_body": "{{SECRET:test-api-key}}" },
            secrets: { "test-api-key": "resolved-secret-42" },
          }],
        },
      },
    })
    createdSandboxes.push(name)
    await pySandbox.fs.write("/tmp/proxy-test.py", pythonHelperScript)
    const pipResult = await pySandbox.process.exec({ command: 'pip install --break-system-packages requests 2>&1', waitForCompletion: true })
    if (pipResult.exitCode !== 0) throw new Error(`pip install failed: ${pipResult.logs?.slice(0, 500)}`)
  }, 120_000)

  it('injects headers via Python requests (respects HTTPS_PROXY)', async () => {
    const result = await pySandbox.process.exec({ command: 'python3 /tmp/proxy-test.py GET https://httpbin.org/headers 2>&1', waitForCompletion: true })
    if (result.exitCode !== 0) throw new Error(`python3 exited ${result.exitCode}: ${result.logs?.slice(0, 1500)}`)
    const headers = lowercaseKeys(parseJsonOutput(result.logs).headers)
    expect(headers["x-blaxel-request-id"]).toBeDefined()
    expect(headers["x-proxy-test"]).toBe("header-injected")
    expect(headers["x-api-key"]).toBe("resolved-secret-42")
  }, 90_000)

  it('injects body fields via Python requests POST', async () => {
    const result = await pySandbox.process.exec({ command: `python3 /tmp/proxy-test.py POST https://httpbin.org/post '{}' '{"user_data":"from-python"}'`, waitForCompletion: true })
    expect(result.exitCode).toBe(0)
    const response = parseJsonOutput(result.logs)
    expect(response.json.user_data).toBe("from-python")
    expect(response.json.injected_field).toBe("body-injected")
    expect(response.json.secret_body).toBe("resolved-secret-42")
  }, 90_000)

  it('preserves user-sent headers via Python requests', async () => {
    const result = await pySandbox.process.exec({ command: `python3 /tmp/proxy-test.py GET https://httpbin.org/headers '{"X-User-Custom":"from-python"}'`, waitForCompletion: true })
    expect(result.exitCode).toBe(0)
    const headers = lowercaseKeys(parseJsonOutput(result.logs).headers)
    expect(headers["x-user-custom"]).toBe("from-python")
    expect(headers["x-proxy-test"]).toBe("header-injected")
  }, 90_000)
})
