import { settings } from "@blaxel/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import dotenv from 'dotenv';

console.log('Connected using Streamable HTTP transport');
// Load environment variables from .env file
dotenv.config();


// Initialize client
const client = new Client({
  name: 'streamable-http-client',
  version: '2.0.0'
});

// Initialize transport
const baseUrl = `${settings.runUrl}/${settings.workspace}/functions/blaxel-search/mcp`
const transport = new StreamableHTTPClientTransport(new URL(baseUrl), { requestInit: { headers: settings.headers } });

// Connect client to transport
await client.connect(transport);

// List tools
const response = await client.listTools();
console.log(`Tools retrieved, number of tools: ${response.tools.length}`);
