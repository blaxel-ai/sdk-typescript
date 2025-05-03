import { getVercelAIModel } from "./vercelai";

export const getMastraModel = async (
  model: string,
  options?: Record<string, unknown>
) => {
  return getVercelAIModel(model, options);
};
