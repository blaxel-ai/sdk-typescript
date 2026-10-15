import { SandboxInstance, SecretInstance, listSecrets } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from '../helpers.js'
import { createEchoServerSandbox, lowercaseKeys, parseJsonOutput, proxyCleanup, proxyHelperScript } from './helpers.js'

// Workspace secrets ship with controlplane#5736; skip until the target environment serves them.
const secretsApiDeployed = (await listSecrets()).response.status !== 404

type Sandbox = Awaited<ReturnType<typeof SandboxInstance.create>>

async function headersSeenByUpstream(sandbox: Sandbox, headersUrl: string, extraHeaders?: string): Promise<Record<string, string>> {
  const command = `node /tmp/proxy-test.js GET ${headersUrl}${extraHeaders ? ` '${extraHeaders}'` : ""}`
  const result = await sandbox.process.exec({ command, waitForCompletion: true })
  expect(result.exitCode, result.logs).toBe(0)
  return lowercaseKeys(parseJsonOutput(result.logs).headers)
}

// A workspace secret write is pushed to the region's proxy synchronously, but the
// running sandbox only observes it on its next proxied request, so poll briefly.
// `expected` undefined means the proxy must stop injecting the header altogether.
async function waitForHeader(sandbox: Sandbox, headersUrl: string, header: string, expected: string | undefined): Promise<void> {
  let seen: string | undefined
  for (let i = 0; i < 15; i++) {
    seen = (await headersSeenByUpstream(sandbox, headersUrl))[header]
    if (seen === expected) return
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  expect(seen).toBe(expected)
}

describe.skipIf(!secretsApiDeployed)('workspace secrets resolved by the proxy', () => {
  const createdSandboxes: string[] = []
  const createdSecrets: string[] = []
  afterAll(async () => {
    await proxyCleanup(createdSandboxes)()
    await Promise.all(createdSecrets.map(async (name) => {
      try { await SecretInstance.delete(name) } catch {
      }
    }))
  })

  const wsSecret = uniqueName("ws-token")
  const sharedName = uniqueName("ws-shared")
  const missingName = uniqueName("ws-missing")

  let sandbox: Sandbox
  let headersUrl: string
  let postUrl: string

  beforeAll(async () => {
    await SecretInstance.set(wsSecret, "ws-value-1")
    createdSecrets.push(wsSecret)
    await SecretInstance.set(sharedName, "workspace-level")
    createdSecrets.push(sharedName)

    const echo = await createEchoServerSandbox(createdSandboxes)
    headersUrl = `${echo.url}/headers`
    postUrl = `${echo.url}/post`

    const name = uniqueName("proxy-ws-sec")
    sandbox = await SandboxInstance.create({
      name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
      network: {
        proxy: {
          routing: [
            {
              destinations: [echo.host],
              headers: {
                "X-Ws-Token": `Bearer {{SECRET:${wsSecret}}}`,
                "X-Shared": `{{SECRET:${sharedName}}}`,
                "X-Missing": `{{SECRET:${missingName}}}`,
              },
              body: { "ws_key": `{{SECRET:${wsSecret}}}` },
              // same name as a workspace secret: the rule-level value must win
              secrets: { [sharedName]: "rule-level" },
            },
          ],
        },
      },
    })
    createdSandboxes.push(name)
    await sandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)
  }, 180_000)

  it('resolves {{SECRET:name}} from a workspace secret the rule does not declare', async () => {
    const headers = await headersSeenByUpstream(sandbox, headersUrl)
    expect(headers["x-ws-token"]).toBe("Bearer ws-value-1")
  }, 60_000)

  it('resolves a workspace secret in POST body fields', async () => {
    const result = await sandbox.process.exec({ command: `node /tmp/proxy-test.js POST ${postUrl} '{}' '{"user_field":"untouched"}'`, waitForCompletion: true })
    expect(result.exitCode, result.logs).toBe(0)
    const response = parseJsonOutput(result.logs)
    expect(response.json.user_field).toBe("untouched")
    expect(response.json.ws_key).toBe("ws-value-1")
  }, 60_000)

  it('resolves a workspace secret in user-sent headers', async () => {
    const headers = await headersSeenByUpstream(sandbox, headersUrl, `{"X-User-Token":"{{SECRET:${wsSecret}}}"}`)
    expect(headers["x-user-token"]).toBe("ws-value-1")
  }, 60_000)

  it('prefers the rule-level secret over a workspace secret with the same name', async () => {
    const headers = await headersSeenByUpstream(sandbox, headersUrl)
    expect(headers["x-shared"]).toBe("rule-level")
  }, 60_000)

  it('does not inject a header whose secret exists nowhere', async () => {
    const headers = await headersSeenByUpstream(sandbox, headersUrl)
    expect(headers["x-missing"]).toBeUndefined()
  }, 60_000)

  it('serves the latest value after the workspace secret is rotated', async () => {
    await SecretInstance.set(wsSecret, "ws-value-2")
    await waitForHeader(sandbox, headersUrl, "x-ws-token", "Bearer ws-value-2")
  }, 90_000)

  it('stops injecting the header once the workspace secret is deleted', async () => {
    await SecretInstance.delete(wsSecret)
    createdSecrets.splice(createdSecrets.indexOf(wsSecret), 1)
    await waitForHeader(sandbox, headersUrl, "x-ws-token", undefined)
  }, 90_000)
})
