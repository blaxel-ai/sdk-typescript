import { tool } from "ai";
import { getLlamaIndexTools, getTool } from "./index.js";

export const getVercelAITool = async (
  name: string
): Promise<Record<string, unknown>> => {
  const toolFormated: Record<string, unknown> = {};
  const blaxelTool = await getTool(name);

  for (const t of blaxelTool) {
    toolFormated[t.name] = tool({
      description: t.description,
      parameters: t.inputSchema,
      execute: t.call.bind(t),
    });
  }
  return toolFormated;
};

export const getVercelAITools = async (
  names: string[]
): Promise<Record<string, unknown>> => {
  const toolArrays = await Promise.all(names.map(getVercelAITool));
  const toolFormated: Record<string, unknown> = {};
  for (const toolServer of toolArrays) {
    for (const toolName in toolServer) {
      toolFormated[toolName] = toolServer[toolName];
    }
  }
  return toolFormated;
};

export default getLlamaIndexTools;
