// @ts-ignore - Required for build time due to missing types in 'llamaindex'
import { tool } from "llamaindex";
import { handleDynamicImportError } from "../common/errors.js";
import { getTool } from "./index.js";

export const getLlamaIndexTool = async (name: string) => {
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

export const getLlamaIndexTools = async (names: string[]) => {
  const toolArrays = await Promise.all(names.map(getLlamaIndexTool));
  return toolArrays.flat();
};

export default getLlamaIndexTools;
