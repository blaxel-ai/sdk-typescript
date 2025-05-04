import { findFromCache } from "../cache/index.js";
import { getModel } from "../client/sdk.gen.js";
import { Model } from "../client/types.gen.js";

export class BLModel {
  modelName: string;
  options?: Record<string, unknown>;

  constructor(modelName: string, options?: Record<string, unknown>) {
    this.modelName = modelName;
    this.options = options || {};
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
