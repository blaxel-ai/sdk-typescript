import { getTool, handleDynamicImportError } from "@blaxel/core";
import type { Tool } from "ai";
import { tool } from "ai";

export const blTool = async (
  name: string,
  ms?: number
) : Promise<Record<string, Tool>> => {
  try {
    const toolFormated: Record<string, Tool> = {};
    const blaxelTool = await getTool(name, ms);

    for (const t of blaxelTool) {
      // @ts-ignore - Type instantiation depth issue with ai package in some environments
      const toolInstance = tool({
        description: t.description,
        parameters: t.inputSchema,
        execute: t.call.bind(t),
      });
      toolFormated[t.name] = toolInstance;
    }
    return toolFormated;
  } catch (err) {
    handleDynamicImportError(err);
    throw err;
  }
};

export const blTools = async (
  names: string[],
  ms?: number
) : Promise<Record<string, Tool>> => {
  const toolArrays = await Promise.all(names.map((n) => blTool(n, ms)));
  const toolFormated: Record<string, Tool> = {};
  for (const toolServer of toolArrays) {
    for (const toolName in toolServer) {
      toolFormated[toolName] = toolServer[toolName];
    }
  }
  return toolFormated;
};
