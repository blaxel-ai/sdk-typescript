import { findFromCache } from "../cache/index.js";
import { Function, getFunction } from "../client/index.js";
import { env } from "../common/env.js";
import { getLangchainTools } from "./langchain.js";
import getLlamaIndexTools from "./llamaindex.js";
import getMastraTools from "./mastra.js";
import { getMcpTool } from "./mcpTool.js";
import { Tool } from "./types.js";
import { getVercelAITools } from "./vertcelai.js";

export * from "./langchain.js";
export * from "./llamaindex.js";
export * from "./mastra.js";
export * from "./vertcelai.js";

export const getTool = async (name: string): Promise<Tool[]> => {
  return await getMcpTool(name);
};

class BLTools {
  toolNames: string[];
  constructor(toolNames: string[]) {
    this.toolNames = toolNames;
  }

  async ToLangChain() {
    return getLangchainTools(this.toolNames);
  }

  async ToLlamaIndex() {
    return getLlamaIndexTools(this.toolNames);
  }

  async ToVercelAI(): Promise<Record<string, unknown>> {
    return getVercelAITools(this.toolNames);
  }

  async ToMastra(): Promise<Record<string, unknown>> {
    return getMastraTools(this.toolNames);
  }
}

export const blTools = (names: string[]) => {
  return new BLTools(names);
};

export const blTool = (name: string) => {
  return new BLTools([name]);
};

export const getToolMetadata = async (
  tool: string
): Promise<Function | null> => {
  const envVar = tool.replace(/-/g, "_").toUpperCase();
  if (env[`BL_FUNCTION_${envVar}_URL`]) {
    return {
      metadata: {
        name: tool,
      },
      spec: {
        runtime: {
          type: "mcp",
        },
      },
    };
  }

  const cacheData = await findFromCache("Function", tool);
  if (cacheData) {
    return cacheData as Function;
  }
  const { data } = await getFunction({
    path: {
      functionName: tool,
    },
  });
  return data || null;
};
