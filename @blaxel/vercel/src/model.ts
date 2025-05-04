import { createAnthropic } from "@ai-sdk/anthropic";
import { createCerebras } from "@ai-sdk/cerebras";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { authenticate, getModelMetadata, handleDynamicImportError, settings } from "@blaxel/sdk";

export const blModel = async (
  model: string,
  options?: Record<string, unknown>
) => {
  const url = `${settings.runUrl}/${settings.workspace}/models/${model}`;
  const modelData = await getModelMetadata(model);
  if (!modelData) {
    throw new Error(`Model ${model} not found`);
  }
  await authenticate();
  const type = modelData?.spec?.runtime?.type || "openai";
  const modelId = modelData?.spec?.runtime?.model || "gpt-4o";

  try {
    if (type === "google") {

      return createGoogleGenerativeAI({
        apiKey: settings.token,
        baseURL: `${url}/v1`,
        ...options,
      })(modelId);
    } else if (type === "anthropic") {

      return createAnthropic({
        apiKey: settings.token,
        baseURL: `${url}`,
        ...options,
      })(modelId);
    } else if (type === "groq") {

      return createGroq({
        apiKey: settings.token,
        baseURL: `${url}`,
        ...options,
      })(modelId);
    } else if (type === "cerebras") {

      return createCerebras({
        apiKey: settings.token,
        baseURL: `${url}/v1`,
        ...options,
      })(modelId);
    }

    return createOpenAI({
      apiKey: settings.token,
      baseURL: `${url}/v1`,
      ...options,
    })(modelId);
  } catch (err) {
    handleDynamicImportError(err);
    throw err;
  }
};
