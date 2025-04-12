import { onLoad } from "../common/autoload";
import { handleDynamicImportError } from "../common/errors";
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

  try {
    if (type === "google") {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      return createGoogleGenerativeAI({
        apiKey: settings.token,
        baseURL: `${url}/v1`,
        ...options,
      })(modelId);
    } else if (type === "anthropic") {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({
        apiKey: settings.token,
        baseURL: `${url}`,
        ...options,
      })(modelId);
    } else if (type === "groq") {
      const { createGroq } = await import("@ai-sdk/groq");
      return createGroq({
        apiKey: settings.token,
        baseURL: `${url}`,
        ...options,
      })(modelId);
    } else if (type === "cerebras") {
      const { createCerebras } = await import("@ai-sdk/cerebras");
      return createCerebras({
        apiKey: settings.token,
        baseURL: `${url}/v1`,
        ...options,
      })(modelId);
    }
    const { createOpenAI } = await import("@ai-sdk/openai");
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
