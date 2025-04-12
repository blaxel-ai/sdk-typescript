import { handleDynamicImportError } from "../common/errors.js";
import { getTool } from "./index.js";

export async function getLangchainTool(name: string) {
  try {
    const { tool } = await import("@langchain/core/tools");
    const blaxelTool = await getTool(name);
    return blaxelTool.map((t) =>
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

export async function getLangchainTools(names: string[]) {
  const toolArrays = await Promise.all(names.map(getLangchainTool));
  return toolArrays.flat();
}
