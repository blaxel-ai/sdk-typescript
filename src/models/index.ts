import { findFromCache } from "../cache/index.js";
import { getModel } from "../client/sdk.gen.js";
import { Model } from "../client/types.gen.js";
import { handleDynamicImportError } from "../common/errors.js";

class BLModel {
  modelName: string;
  options?: Record<string, unknown>;

  constructor(modelName: string, options?: Record<string, unknown>) {
    this.modelName = modelName;
    this.options = options || {};
  }

  async ToLangChain() {
    try {
      const { getLangchainModel } = await import("./langchain.js");
      return getLangchainModel(this.modelName, this.options);
    } catch (err) {
      handleDynamicImportError(err);
      throw err;
    }
  }

  async ToLlamaIndex() {
    try {
      const { getLlamaIndexModel } = await import("./llamaindex.js");
      return getLlamaIndexModel(this.modelName, this.options);
    } catch (err) {
      handleDynamicImportError(err);
      throw err;
    }
  }

  async ToVercelAI() {
    try {
      const { getVercelAIModel } = await import("./vercelai.js");
      return getVercelAIModel(this.modelName, this.options);
    } catch (err) {
      handleDynamicImportError(err);
      throw err;
    }
  }

  async ToMastra() {
    try {
      const { getMastraModel } = await import("./mastra.js");
      return getMastraModel(this.modelName, this.options);
    } catch (err) {
      handleDynamicImportError(err);
      throw err;
    }
  }
}

export const blModel = (
  modelName: string,
  options?: Record<string, unknown>
) => {
  return new BLModel(modelName, options);
};

export const getModelMetadata = async (
  model: string
): Promise<Model | null> => {
  const cacheData = await findFromCache("Model", model);
  if (cacheData) {
    return cacheData as Model;
  }
  const { data } = await getModel({
    path: {
      modelName: model,
    },
  });
  return data || null;
};
