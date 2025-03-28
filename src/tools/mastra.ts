import { getTool } from "./index.js";
import { tool } from "ai";

export const getMastraTool = async (name: string): Promise<any> => {
  const toolFormated: Record<string, any> = {};
  const blaxelTool = await getTool(name);

  // I was not able to make it work with createTool from mastra,
  // But mastra is compatible with vercel ai sdk format.
  // https://mastra.ai/docs/agents/02-adding-tools
  for (const t of blaxelTool) {
    toolFormated[t.name] = tool({
      description: t.description,
      parameters: t.inputSchema,
      execute: t.call,
    });
  }
  return toolFormated;
};

export const getMastraTools = async (names: string[]): Promise<any> => {
  const toolArrays = await Promise.all(names.map(getMastraTool));
  const toolFormated: Record<string, any> = {};
  for (const toolServer of toolArrays) {
    for (const toolName in toolServer) {
      toolFormated[toolName] = toolServer[toolName];
    }
  }
  return toolFormated;
};

export default getMastraTools;
