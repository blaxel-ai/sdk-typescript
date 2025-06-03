import { findFromCache } from "../cache/index.js";
import { Function, getFunction } from "../client/client.js";
import { getForcedUrl } from "../common/internal.js";
import { getMcpTool } from "./mcpTool.js";
import { Tool } from "./types.js";

export const getTool = async (name: string, ms?: number): Promise<Tool[]> => {
  return await getMcpTool(name, ms);
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
  const forcedUrl = getForcedUrl('function', tool)
  if(forcedUrl) {
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
