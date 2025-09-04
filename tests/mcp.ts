import { BlaxelMcpClientTransport, settings } from "@blaxel/core";
import { Client as ModelContextProtocolClient } from "@modelcontextprotocol/sdk/client/index.js";
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

async function sampleMcpBlaxel(name: string): Promise<void> {
  const transport = new BlaxelMcpClientTransport(
    `wss://run.blaxel.ai/${settings.workspace}/functions/${name}`,
    settings.headers
  );

  const client = new ModelContextProtocolClient(
    {
      name: name,
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );
  try {
    await client.connect(transport);
    const response = await client.listTools();
    console.log(`Tools retrieved, number of tools: ${response.tools.length}`);

    // Call the tool, specify the correct tool name and arguments
    const result = await client.callTool({
      name: "tables",
      arguments: {}
    });
    console.log(`Tool call result: ${JSON.stringify(result)}`);
  } finally {
    await client.close();
    await transport.close();
  }
}

sampleMcpBlaxel("convex-mcp").catch(console.error);


