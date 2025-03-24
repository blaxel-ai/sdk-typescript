import { findFromCache } from "../cache/index.js";
import { Function, getFunction } from "../client/index.js";
import { getHttpTool } from "./httpTool.js";
import { getLangchainTools } from "./langchain.js";
import getLlamaIndexTools from "./llamaindex.js";
import { getMcpTool } from "./mcpTool.js";
import { Tool } from "./types.js";
import { getVercelAITools } from "./vertcelai.js";

export * from "./langchain.js";
export * from "./llamaindex.js";
export * from "./vertcelai.js";

export const getTool = async (name: string): Promise<Tool[]> => {
  const functionData = await getToolMetadata(name)
  if(!functionData) {
    throw new Error(`Function ${name} not found`)
  }
  if (functionData?.spec?.runtime?.type === "mcp") {
    return await getMcpTool(functionData)
  }
  return await getHttpTool(functionData)
}

class BLTools {
  toolNames: string[]
  constructor(toolNames: string[]) {
    this.toolNames = toolNames
  }

  async ToLangChain() {
    return getLangchainTools(this.toolNames)
  }

  async ToLlamaIndex() {
    return getLlamaIndexTools(this.toolNames)
  }

  async ToVercelAI() {
    return getVercelAITools(this.toolNames)
  }
}

export const blTools = (names: string[]) => {
  return new BLTools(names)
}

export const blTool = (name: string) => {
  return new BLTools([name])
}

export const getToolMetadata = async (tool: string) : Promise<Function | null> => {
  const cacheData = await findFromCache('Function', tool)
  if(cacheData) {
    return cacheData as Function
  }
  const {data} = await getFunction({
    path: {
      functionName: tool,
    },
  });
  return data || null
}

