import { findFromCache } from "../cache/index.js";
import { Function, getFunction } from "../client/client.js";
import { env } from "../common/env.js";
import { getMcpTool } from "./mcpTool.js";
import { Tool } from "./types.js";

export const getTool = async (name: string): Promise<Tool[]> => {
  return await getMcpTool(name);
};

export class BLTools {
  toolNames: string[];
  constructor(toolNames: string[]) {
    this.toolNames = toolNames;
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
