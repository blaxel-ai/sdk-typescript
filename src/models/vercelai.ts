import { createAnthropic } from "@ai-sdk/anthropic";
import { createCerebras } from "@ai-sdk/cerebras";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { onLoad } from "../common/autoload";
import settings from "../common/settings";
import { getModelMetadata } from "./index";

export const getVercelAIModel = async (
  model: string,
  options?: Record<string, unknown>
) => {
  const url = `${settings.runUrl}/${settings.workspace}/models/${model}`;
  const modelData = await getModelMetadata(model);
  if (!modelData) {
    throw new Error(`Model ${model} not found`);
  }
  await onLoad();
  const type = modelData?.spec?.runtime?.type || "openai";
  const modelId = modelData?.spec?.runtime?.model || "gpt-4o";
  switch (type) {
    case "mistral":
      return createMistral({
        apiKey: settings.token,
        baseURL: `${url}/v1`,
        ...options,
      })(modelId);
    case "anthropic":
      return createAnthropic({
        apiKey: settings.token,
        baseURL: `${url}`,
        ...options,
      })(modelId);
    case "cerebras":
      return createCerebras({
        apiKey: settings.token,
        baseURL: `${url}/v1`,
        ...options,
      })(modelId);
    default:
      return createOpenAI({
        apiKey: settings.token,
        baseURL: `${url}/v1`,
        ...options,
      })(modelId);
  }
};
