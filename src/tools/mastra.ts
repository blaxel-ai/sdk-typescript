import { getVercelAITools } from "./index.js";

export const getMastraTools = async (
  names: string[]
): Promise<Record<string, unknown>> => {
  return getVercelAITools(names);
};

export default getMastraTools;
