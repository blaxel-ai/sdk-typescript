import { describe, it, expect } from 'vitest'

// Note: These tests require special authentication setup for raw MCP SDK
// The blTools wrapper in bltools.test.ts handles auth automatically
import { settings } from "@blaxel/core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

describe('MCP Client Integration', () => {
  it('Streamable HTTP Transport', async () => {

      const client = new Client({
        name: 'streamable-http-client',
        version: '2.0.0'
      })

      const baseUrl = `${settings.runUrl}/${settings.workspace}/functions/blaxel-search/mcp`
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

