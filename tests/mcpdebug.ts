import { BlaxelMcpClientTransport, logger } from "@blaxel/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const transport = new BlaxelMcpClientTransport(
  'wss://0nav5pgjxbn4l0hyc4.host-002-141.us-west-2.dev.aws.beamlit.net'
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
  logger.info(JSON.stringify(tools));

  // const result = await client.callTool({
  //   name:"hello_world",
  //   arguments:{ first_name: "John" }
  // });
  // logger.info(JSON.stringify(result))

  await client.close();
  process.exit(0);
}

main().catch(logger.error);
