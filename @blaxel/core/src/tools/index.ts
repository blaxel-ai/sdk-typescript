import { getMcpTool, ToolOptions } from "./mcpTool.js";
import { Tool } from "./types.js";

export type { ToolOptions };

export const getTool = async (name: string, options?: number | ToolOptions): Promise<Tool[]> => {
  return await getMcpTool(name, options);
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
