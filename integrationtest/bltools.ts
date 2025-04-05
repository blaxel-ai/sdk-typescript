import { blTools, getTool } from "../src"
import { logger } from "../src/common/logger"


async function main() {
  await test_mcp_tools_langchain()
  await test_mcp_tools_llamaindex()
  await test_mcp_tools_vercel()
  await test_mcp_tools_mastra()
  await test_mcp_tools_blaxel()
}

async function test_mcp_tools_langchain(){
  const tools = await blTools(["blaxel-search"]).ToLangChain()
  if(tools.length === 0){
    throw new Error("No tools found")
  }
  const result = await tools[0].invoke({ query: "What is the capital of France?" })
  logger.info(result)
}

async function test_mcp_tools_llamaindex(){
  const tools = await blTools(["blaxel-search"]).ToLlamaIndex()
  if(tools.length === 0){
    throw new Error("No tools found")
  }
  const result = await tools[0].call({ query: "What is the capital of France?" })
  logger.info(result)
}

async function test_mcp_tools_vercel(){
  const tools = await blTools(["blaxel-search"]).ToVercelAI()
  if(!tools.search){
    throw new Error("No tools found")
  }
  const result = await tools.search.execute({ query: "What is the capital of France?" })
  logger.info(result)
}

async function test_mcp_tools_mastra(){
  const tools = await blTools(["blaxel-search"]).ToMastra()
  if(!tools.search){
    throw new Error("No tools found")
  }
  const result = await tools.search.execute({ query: "What is the capital of France?" })
  logger.info(result)
}

async function test_mcp_tools_blaxel(){
  const tools = blTools(["blaxel-search"])
  const toolsBootted = await Promise.all(tools.toolNames.map(async (name) => {
    return await getTool(name);
  }))
  logger.info(toolsBootted)
  const result = await toolsBootted[0][0].call({query: "What is the capital of France?"})
  logger.info(result)
  const result2 = await toolsBootted[0][0].call({query: "What is the capital of Germany?"})
  logger.info(result2)
  logger.info("Waiting 7 seconds")
  await new Promise(resolve => setTimeout(resolve, 7000));
  const result3 = await toolsBootted[0][0].call({query: "What is the capital of USA?"})
  logger.info(result3)
  const result4 = await toolsBootted[0][0].call({query: "What is the capital of Canada?"})
  logger.info(result4)
}
main().catch(err=>{
  console.error(err)
  process.exit(1)
})
.then(()=>{
  process.exit(0)
})