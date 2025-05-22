import { BlaxelMcpClientTransport, SandboxInstance, settings } from "@blaxel/core";
import { blTools as langgraphTools } from "@blaxel/langgraph";
import { Client as ModelContextProtocolClient } from "@modelcontextprotocol/sdk/client/index.js";

async function testMcpTools(sandboxName: string) {
  const tools = await langgraphTools([`sandbox/${sandboxName}`]);
  if (tools.length === 0) {
    throw new Error("No tools found");
  }
  const tool = tools.find((tool) => tool.name === "processExecute");
  if (tool) {
    const result = await tool.invoke({
      command: "ls -la",
      waitForCompletion: true
    });
    console.info(result);
  }
}

async function main() {
  const sandboxName = "sandbox-test"
  const sandbox = await SandboxInstance.createIfNotExists({
    metadata: {
      name: sandboxName
    },
    spec: {
      runtime: {
        image: "blaxel/prod-nextjs:latest",
        memory: 4096,
        ports: [
          {
            name: "sandbox-api",
            target: 8080,
            protocol: "HTTP",
          },
          {
            name: "preview",
            target: 3000,
            protocol: "HTTP",
          }
        ]
      }
    }
  })
  await sandbox.wait()
  await testMcpTools(sandboxName)

  const url = `${settings.runUrl}/${settings.workspace}/sandboxes/${sandboxName}`
  const transport = new BlaxelMcpClientTransport(
    url.toString(),
    settings.headers,
  );
  const client = new ModelContextProtocolClient(
    {
      name: "mcp-sandbox-api",
      version: "1.0.0",
    },
    { capabilities: { tools: {} } }
  );
  await client.connect(transport)
  const fileName = `/blaxel/tmp/testfile_.txt`;
  const content = `Test content`;
  await client.callTool({name: "fsWriteFile", arguments: {path: fileName, content: content}})
  console.log("File written")
  await client.close()
}

main()
.catch((err) => {
  console.error("There was an error => ", err);
  process.exit(1);
})
.then(() => {
  process.exit(0);
})
