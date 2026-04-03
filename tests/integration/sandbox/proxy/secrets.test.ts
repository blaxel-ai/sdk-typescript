import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName, sleep } from '../helpers.js'
import { lowercaseKeys, parseJsonOutput, proxyCleanup, proxyHelperScript } from './helpers.js'

describe('secrets replacement validation', () => {
  const createdSandboxes: string[] = []
  afterAll(proxyCleanup(createdSandboxes))

  let secretSandbox: Awaited<ReturnType<typeof SandboxInstance.create>>

  beforeAll(async () => {
    const name = uniqueName("proxy-sec")
    secretSandbox = await SandboxInstance.create({
      name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
      network: {
        proxy: {
          routing: [
            {
              destinations: ["httpbin.org"],
              headers: { "X-Token": "Bearer {{SECRET:api-token}}", "X-Multi": "{{SECRET:part-a}}-{{SECRET:part-b}}", "X-Plain": "no-secret-here" },
              body: { "secret_key": "{{SECRET:api-token}}", "composite": "prefix-{{SECRET:part-a}}-suffix" },
              secrets: { "api-token": "tok_live_abc123", "part-a": "ALPHA", "part-b": "BETA" },
            },
            {
              destinations: ["*.example.com"],
              headers: { "X-Other-Secret": "{{SECRET:other-key}}" },
              secrets: { "other-key": "other-value-999" },
            },
          ],
        },
      },
    })
    createdSandboxes.push(name)
    await secretSandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
  }, 60_000)

  it('resolves {{SECRET:name}} in headers to actual value', async () => {
    const result = await secretSandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers', waitForCompletion: true })
    expect(result.exitCode).toBe(0)
    const headers = lowercaseKeys(parseJsonOutput(result.logs).headers)
    expect(headers["x-token"]).toBe("Bearer tok_live_abc123")
    expect(headers["x-plain"]).toBe("no-secret-here")
  }, 60_000)

  it('resolves multiple {{SECRET:...}} placeholders in a single header', async () => {
    const result = await secretSandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers', waitForCompletion: true })
    expect(result.exitCode).toBe(0)
    const headers = lowercaseKeys(parseJsonOutput(result.logs).headers)
    expect(headers["x-multi"]).toBe("ALPHA-BETA")
  }, 60_000)

  it('resolves {{SECRET:name}} in POST body fields', async () => {
    const result = await secretSandbox.process.exec({ command: `node /tmp/proxy-test.js POST https://httpbin.org/post '{}' '{"user_field":"untouched"}'`, waitForCompletion: true })
    expect(result.exitCode).toBe(0)
    const response = parseJsonOutput(result.logs)
    expect(response.json.user_field).toBe("untouched")
    expect(response.json.secret_key).toBe("tok_live_abc123")
    expect(response.json.composite).toBe("prefix-ALPHA-suffix")
  }, 60_000)

  it('does not leak secrets from one route to another destination', async () => {
    const result = await secretSandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers', waitForCompletion: true })
    expect(result.exitCode).toBe(0)
    const headers = lowercaseKeys(parseJsonOutput(result.logs).headers)
    expect(headers["x-other-secret"]).toBeUndefined()
  }, 60_000)

  it('does not expose raw {{SECRET:...}} template on the wire', async () => {
    const result = await secretSandbox.process.exec({ command: 'node /tmp/proxy-test.js GET https://httpbin.org/headers', waitForCompletion: true })
    expect(result.exitCode).toBe(0)
    expect(result.logs || "").not.toContain("{{SECRET:")
  }, 60_000)

  it('resolves {{SECRET:name}} in user-sent headers', async () => {
    const result = await secretSandbox.process.exec({ command: `node /tmp/proxy-test.js GET https://httpbin.org/headers '{"X-User-Token":"{{SECRET:api-token}}","X-User-Combo":"pre-{{SECRET:part-a}}-post"}'`, waitForCompletion: true })
    expect(result.exitCode).toBe(0)
    const headers = lowercaseKeys(parseJsonOutput(result.logs).headers)
    expect(headers["x-user-token"]).toBe("tok_live_abc123")
    expect(headers["x-user-combo"]).toBe("pre-ALPHA-post")
  }, 60_000)

  it('resolves {{SECRET:name}} in user-sent POST body', async () => {
    const result = await secretSandbox.process.exec({ command: `node /tmp/proxy-test.js POST https://httpbin.org/post '{}' '{"api_key":"{{SECRET:api-token}}","mixed":"hello-{{SECRET:part-b}}-world"}'`, waitForCompletion: true })
    expect(result.exitCode).toBe(0)
    const response = parseJsonOutput(result.logs)
    expect(response.json.api_key).toBe("tok_live_abc123")
    expect(response.json.mixed).toBe("hello-BETA-world")
  }, 60_000)

  it('does not resolve secrets from a different route in user-sent headers', async () => {
    const result = await secretSandbox.process.exec({ command: `node /tmp/proxy-test.js GET https://httpbin.org/headers '{"X-Wrong-Route":"{{SECRET:other-key}}"}'`, waitForCompletion: true })
    expect(result.exitCode).toBe(0)
    const headers = lowercaseKeys(parseJsonOutput(result.logs).headers)
    expect(headers["x-wrong-route"]).toBe("{{SECRET:other-key}}")
  }, 60_000)
})
