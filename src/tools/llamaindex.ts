import type { FunctionTool, JSONValue } from "llamaindex" with { "resolution-mode": "import" };
// @ts-expect-error - tool is not exported from llamaindex
import { tool } from "llamaindex";
import { getTool } from "./index.js";

// Define a type for JSON objects
type JSONObject = { [key: string]: JSONValue };

// Use JSONObject for the input type
export const getLlamaIndexTool = async (
  name: string
): Promise<FunctionTool<JSONObject, JSONValue | Promise<JSONValue>>[]> => {

  const blaxelTool = await getTool(name);
  const tools = blaxelTool.map((t) => {
    return tool({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      execute: async (input: JSONObject): Promise<JSONValue> => {
        // Await the promise to ensure the return type is JSONValue
        const result = await t.call(input);
        return result as JSONValue;
      },
    });
  });
  return tools;
};

export const getLlamaIndexTools = async (
  names: string[]
): Promise<FunctionTool<JSONObject, JSONValue | Promise<JSONValue>>[]> => {
  const toolArrays = await Promise.all(names.map(getLlamaIndexTool));
  return toolArrays.flat();
};

export default getLlamaIndexTools;
