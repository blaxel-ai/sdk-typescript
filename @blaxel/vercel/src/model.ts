import { createAnthropic } from "@ai-sdk/anthropic";
import { createCerebras } from "@ai-sdk/cerebras";
import { createCohere } from "@ai-sdk/cohere";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { authenticate, getModelMetadata, handleDynamicImportError, settings } from "@blaxel/core";

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
    if (type === "gemini") {
      return createGoogleGenerativeAI({
        apiKey: settings.token,
        headers: settings.headers,
        fetch: (_, options) => {
          return fetch(`${url}/v1beta/models/${modelId}:generateContent`, options)
        },
        ...options,
      })(modelId);
    } else if (type === "anthropic") {
      return createAnthropic({
        apiKey: settings.token,
        baseURL: `${url}/v1`,
        headers: settings.headers,
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
    } else if (type === "cohere") {

      return createCohere({
        apiKey: settings.token,
        baseURL: `${url}/v2`,
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
