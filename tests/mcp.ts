import { BlaxelMcpClientTransport, env } from "@blaxel/core";
import { Client as ModelContextProtocolClient } from "@modelcontextprotocol/sdk/client/index.js";
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

async function sampleMcpBlaxel(name: string): Promise<void> {
  const apiKey = env.BL_API_KEY;
  const workspace = env.BL_WORKSPACE;

  if (!apiKey || !workspace) {
    throw new Error("BL_API_KEY and BL_WORKSPACE environment variables must be set");
  }

  const headers = {
    "X-Blaxel-Authorization": `Bearer ${apiKey}`
  };

  const transport = new BlaxelMcpClientTransport(
    `wss://run.blaxel.ai/${workspace}/functions/${name}`,
    headers
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
      name: "search_issues",
      arguments: { query: "test" }
    });
    console.log(`Tool call result: ${JSON.stringify(result)}`);
  } finally {
    await client.close();
    await transport.close();
  }
}

// Example usage
if (require.main === module) {
  sampleMcpBlaxel("linear-demo").catch(console.error);
}


