import { getVercelAITools } from "./vertcelai.js";

export const getMastraTools = async (
  names: string[]
): Promise<Record<string, unknown>> => {
  return getVercelAITools(names);
};

export default getMastraTools;
