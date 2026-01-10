import { describe, it, expect, beforeAll, afterAll } from 'vitest'

// Note: These tests require special authentication setup for raw MCP SDK
// The blTools wrapper in bltools.test.ts handles auth automatically
import { settings, SandboxInstance } from "@blaxel/core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { uniqueName, defaultImage, defaultLabels } from '../sandbox/helpers.js'

describe('MCP Client Integration', () => {
  let sandbox: SandboxInstance
  const sandboxName = uniqueName("mcp-test")

  beforeAll(async () => {
    sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: defaultImage,
      memory: 2048,
      labels: defaultLabels,
    })
  })

  afterAll(async () => {
    try {
      await SandboxInstance.delete(sandboxName)
    } catch {
      // Ignore
    }
  })

  it('Streamable HTTP Transport', async () => {
    const client = new Client({
      name: 'streamable-http-client',
      version: '2.0.0'
    })

    const baseUrl = `${sandbox.metadata?.url}/mcp`
    const transport = new StreamableHTTPClientTransport(
      new URL(baseUrl),
      { requestInit: { headers: settings.headers }}
    )

    await client.connect(transport)

    // Verify connection worked
    expect(client).toBeDefined()

    const response = await client.listTools()

    expect(response).toBeDefined()
  })
})
