// @ts-ignore - Required for build time due to missing types in 'llamaindex'
import { getTool, handleDynamicImportError } from "@blaxel/core";
import { ToolOptions } from "@blaxel/core/tools/mcpTool";
import { tool } from "llamaindex";

export const blTool = async (name: string, options?: ToolOptions | number) => {
  try {
    const blaxelTool = await getTool(name, options)
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

export const blTools = async (names: string[], ms?: number) => {
  const toolArrays = await Promise.all(names.map((n) => blTool(n, ms)));
  return toolArrays.flat();
};
