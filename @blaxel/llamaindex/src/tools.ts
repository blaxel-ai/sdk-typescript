// @ts-ignore - Required for build time due to missing types in 'llamaindex'
import { getTool, handleDynamicImportError } from "@blaxel/core";
import { tool } from "llamaindex";

export const blTool = async (name: string) => {
  try {
    const blaxelTool = await getTool(name);
    const tools = blaxelTool.map((t) => {
      // @ts-ignore - Required for build time due to missing types in 'llamaindex'
      return tool(t.call.bind(t), {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      });
    });
    return tools;
  } catch (err) {
    handleDynamicImportError(err);
    throw err;
  }
};

export const blTools = async (names: string[]) => {
  const toolArrays = await Promise.all(names.map(blTool));
  return toolArrays.flat();
};
