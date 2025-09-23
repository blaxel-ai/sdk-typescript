import { blTools, getTool, logger } from "@blaxel/core";
import { blTools as langgraphTools } from "@blaxel/langgraph";
import { blTools as llamaindexTools } from "@blaxel/llamaindex";
import { blTools as mastraTools } from "@blaxel/mastra";
import { blTools as vercelTools } from "@blaxel/vercel";

async function main() {
  // await test_mcp_tools_langchain();
  // await test_mcp_tools_llamaindex();
  // await test_mcp_tools_vercel();
  // await test_mcp_tools_mastra();
  // await test_mcp_tools_blaxel();
  await tmp_test_mcp_stream_and_ws();
}

async function test_mcp_tools_langchain() {
  const tools = await langgraphTools(["blaxel-search"]);
  if (tools.length === 0) {
    throw new Error("No tools found");
  }
  const result = await tools[0].invoke({
    query: "What is the capital of France?",
  });
  console.info(result);
}

async function test_mcp_tools_llamaindex() {
  const tools = await llamaindexTools(["blaxel-search"]);
  if (tools.length === 0) {
    throw new Error("No tools found");
  }
  const result = await tools[0].call({
    query: "What is the capital of France?",
  });
  logger.info(result);
}

async function test_mcp_tools_vercel() {
  const tools = await vercelTools(["blaxel-search"]);
  console.log(tools);
  if (!tools.web_search_exa) {
    throw new Error("No tools found");
  }
  // @ts-ignore
  const result = await tools.web_search_exa.execute({
    query: "What is the capital of France?",
  });
  logger.info(result);
}

async function test_mcp_tools_mastra() {
  const tools = await mastraTools(["blaxel-search"]);
  if (!tools.web_search_exa) {
    throw new Error("No tools found");
  }
  // @ts-ignore
  const result = await tools.web_search_exa.execute({
    query: "What is the capital of France?",
  });
  logger.info(result);
}

async function test_mcp_tools_blaxel() {
  const tools = blTools(["blaxel-search"]);
  const toolsBootted = await Promise.all(
    tools.toolNames.map(async (name) => {
      return await getTool(name);
    })
  );
  logger.info(toolsBootted);
  const result = await toolsBootted[0][0].call({
    query: "What is the capital of France?",
  });
  logger.info(result);
  const result2 = await toolsBootted[0][0].call({
    query: "What is the capital of Germany?",
  });
  logger.info(result2);
  logger.info("Waiting 7 seconds");
  await new Promise((resolve) => setTimeout(resolve, 7000));
  const result3 = await toolsBootted[0][0].call({
    query: "What is the capital of USA?",
  });
  logger.info(result3);
  const result4 = await toolsBootted[0][0].call({
    query: "What is the capital of Canada?",
  });
  logger.info(result4);
}
async function tmp_test_mcp_stream_and_ws() {
  const tools = await langgraphTools(["trello-mk2", "blaxel-search", "sandboxes/base"]);
  let hasTrello = false
  let hasWebSearch = false
  let hasSandbox = false
  for (const tool of tools) {
    if (tool.name === "get_cards_by_list_id") {
      hasTrello = true;
    }
    if (tool.name === "web_search_exa") {
      hasWebSearch = true;
    }
    if (tool.name === "fsGetWorkingDirectory") {
      hasSandbox = true;
    }
  }
  if (!hasTrello) {
    throw new Error("trello-mk2 tool not found");
  }
  if (!hasWebSearch) {
    throw new Error("web_search_exa tool not found");
  }
  if (!hasSandbox) {
    throw new Error("fsGetWorkingDirectory tool not found");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => {
    process.exit(0);
  });
