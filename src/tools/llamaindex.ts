/* eslint-disable @typescript-eslint/no-require-imports */
const { tool } = require("llamaindex") as {
  tool: (config: {
    name: string;
    description: string;
    parameters: any;
    execute: (args: any, options?: any) => Promise<any>;
  }) => Tool;
};
import { Tool } from "ai";
import { getTool } from "./index.js";

export const getLlamaIndexTool = async (name: string): Promise<unknown[]> => {
  const blaxelTool = await getTool(name);

  return blaxelTool.map((t) => {
    return tool({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      execute: t.call.bind(t),
    });
  });
};

export const getLlamaIndexTools = async (
  names: string[]
): Promise<unknown[]> => {
  const toolArrays = await Promise.all(names.map(getLlamaIndexTool));
  return toolArrays.flat();
};

export default getLlamaIndexTools;
