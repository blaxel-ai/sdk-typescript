import { BlaxelMcpClientTransport, logger, settings } from "@blaxel/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// const url = "https://run.blaxel.ai/main/sandboxes/cploujoux-test";
const url = "http://localhost:8080";
const transport = new BlaxelMcpClientTransport(
  url,
  settings.headers
);

const client = new Client(
  {
    name: "mcp-client",
    version: "1.0.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

async function main() {
  await client.connect(transport);
  const {tools} = await client.listTools();
  console.log(JSON.stringify(tools));

  const result = await client.callTool({
    name:"hello_world",
    arguments:{ first_name: "John" }
  });
  logger.info(JSON.stringify(result))

  await client.close();
  process.exit(0);
}

main().catch(console.error);
