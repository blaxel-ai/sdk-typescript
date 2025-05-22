import type { Tool } from "@blaxel/core";
import { getTool, handleDynamicImportError } from "@blaxel/core";
import { tool } from "@langchain/core/tools";
export async function blTool(name: string, ms?: number) {
  try {
    const blaxelTool = await getTool(name, ms);
    return blaxelTool.map((t: Tool) =>
      tool(t.call.bind(t), {
        name: t.name,
        description: t.description,
        schema: t.inputSchema,
      })
    );
  } catch (err) {
    handleDynamicImportError(err);
    throw err;
  }
}

export async function blTools(names: string[], ms?: number) {
  const toolArrays = await Promise.all(names.map((n) => blTool(n, ms)));
  return toolArrays.flat();
}
