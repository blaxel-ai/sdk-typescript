import type { Tool } from "@blaxel/sdk";
import { getTool, handleDynamicImportError } from "@blaxel/sdk";
import { tool } from "@langchain/core/tools";
export async function blTool(name: string) {
  try {
    const blaxelTool = await getTool(name);
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

export async function blTools(names: string[]) {
  const toolArrays = await Promise.all(names.map(blTool));
  return toolArrays.flat();
}
