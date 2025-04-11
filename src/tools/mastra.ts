import { getTool } from "./index.js";

interface Tool {
  name: string;
  description: string;
  inputSchema: any; // Replace with a more specific type if possible
  execute: (args: any, options?: any) => Promise<any>; // Adjusted to match the tool function's return type
}

export const getMastraTool = async (
  name: string
): Promise<Record<string, Tool>> => {
  const toolFormated: Record<string, Tool> = {};
  const blaxelTool = await getTool(name);

  // I was not able to make it work with createTool from mastra,
  // But mastra is compatible with vercel ai sdk format.
  // https://mastra.ai/docs/agents/02-adding-tools
  for (const t of blaxelTool) {
    toolFormated[t.name] = {
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      execute: t.call.bind(t),
    };
  }
  return toolFormated;
};

export const getMastraTools = async (
  names: string[]
): Promise<Record<string, unknown>> => {
  const toolArrays = await Promise.all(names.map(getMastraTool));
  const toolFormated: Record<string, Tool> = {};
  for (const toolServer of toolArrays) {
    for (const toolName in toolServer) {
      toolFormated[toolName] = toolServer[toolName];
    }
  }
  return toolFormated;
};

export default getMastraTools;
