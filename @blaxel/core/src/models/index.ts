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

function extractErrorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object") {
    const body = error as { message?: unknown; error?: unknown };
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
  }
  return undefined;
}

function describeModelFailure(
  response: Response | undefined,
  error: unknown
): string {
  const parts: string[] = [];
  if (response?.status) {
    parts.push(`HTTP ${response.status}`);
  }
  const detail = extractErrorMessage(error);
  if (detail) {
    parts.push(detail);
  }
  return parts.length > 0 ? ` (${parts.join(": ")})` : "";
}

export const getModelMetadata = async (
  model: string
): Promise<Model | null> => {
  const cacheData = await findFromCache("Model", model);
  if (cacheData) {
    return cacheData as Model;
  }
  const { data, error, response } = await getModel({
    path: {
      modelName: model,
    },
  });
  if (data) {
    return data;
  }
  // A 404 is the only response that means the model genuinely does not exist;
  // callers translate `null` into a "Model <name> not found" error. Any other
  // failure (401/403 auth, 5xx, or a transport error with no response) must
  // NOT be reported as "not found" — doing so masks the real cause behind a
  // misleading message and misleading telemetry. Surface it instead.
  if (response?.status === 404) {
    return null;
  }
  if (response || error) {
    throw new Error(
      `Failed to fetch model ${model}${describeModelFailure(response, error)}`
    );
  }
  return null;
};
