import { createAnthropic } from "@ai-sdk/anthropic";
import { createCerebras } from "@ai-sdk/cerebras";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { onLoad } from "../common/autoload";
import settings from "../common/settings";
import { getModelMetadata } from "./index";

export const getMastraModel = async (
  model: string,
  options?: Record<string, unknown>
): Promise<unknown> => {
  const url = `${settings.runUrl}/${settings.workspace}/models/${model}`;
  const modelData = await getModelMetadata(model);
  if (!modelData) {
    throw new Error(`Model ${model} not found`);
  }
  await onLoad();
  const type = modelData?.spec?.runtime?.type || "openai";
  const modelId = modelData?.spec?.runtime?.model || "gpt-4o";
  switch (type) {
    case "google":
      return createGoogleGenerativeAI({
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
    case "groq":
      return createGroq({
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
