import { LanguageModelLike } from "@langchain/core/language_models/base";
import { onLoad } from "../common/autoload";
import settings from "../common/settings";
import { getModelMetadata } from "./index";
import { handleDynamicImportError } from "../common/errors";

export const getLangchainModel = async (
  model: string,
  options?: Record<string, unknown>
): Promise<LanguageModelLike> => {
  const url = `${settings.runUrl}/${settings.workspace}/models/${model}`;
  const modelData = await getModelMetadata(model);
  if (!modelData) {
    throw new Error(`Model ${model} not found`);
  }
  await onLoad();
  const type = modelData?.spec?.runtime?.type || "openai";
  try {
    if (type === "gemini") {
      const { ChatGoogleGenerativeAI } = await import(
        "./langchain/google-genai/index.js"
      );
      return new ChatGoogleGenerativeAI({
        apiKey: settings.token,
        model: modelData?.spec?.runtime?.model,
        baseUrl: url,
        ...options,
      });
    } else if (type === "mistral") {
      const { ChatOpenAI } = await import("@langchain/openai");
      return new ChatOpenAI({
        apiKey: settings.token,
        model: modelData?.spec?.runtime?.model,
        configuration: {
          baseURL: `${url}/v1`,
        },
        ...options,
      });
    } else if (type === "cohere") {
      const { ChatCohere } = await import("@langchain/cohere");
      const { CohereClient } = await import("cohere-ai");
      return new ChatCohere({
        apiKey: settings.token,
        model: modelData?.spec?.runtime?.model,
        client: new CohereClient({
          token: settings.token,
          environment: url,
        }),
      });
    } else if (type === "deepseek") {
      const { ChatDeepSeek } = await import("@langchain/deepseek");
      return new ChatDeepSeek({
        apiKey: settings.token,
        model: modelData?.spec?.runtime?.model,
        configuration: {
          baseURL: `${url}/v1`,
        },
        ...options,
      });
    } else if (type === "anthropic") {
      const { ChatAnthropic } = await import("@langchain/anthropic");
      return new ChatAnthropic({
        anthropicApiUrl: url,
        model: modelData?.spec?.runtime?.model,
        clientOptions: {
          defaultHeaders: settings.headers,
        },
        ...options,
      });
    } else if (type === "xai") {
      const { ChatXAI } = await import("./langchain/xai.js");
      return new ChatXAI({
        apiKey: settings.token,
        configuration: {
          baseURL: `${url}/v1`,
        },
        model: modelData?.spec?.runtime?.model,
        ...options,
      });
    } else if (type === "cerebras") {
      // We don't use ChatCerebras because there is a problem with apiKey headers
      const { ChatOpenAI } = await import("@langchain/openai");
      return new ChatOpenAI({
        apiKey: settings.token,
        model: modelData?.spec?.runtime?.model,
        configuration: {
          baseURL: `${url}/v1`,
        },
        ...options,
      });
    }
    const { ChatOpenAI } = await import("@langchain/openai");
    return new ChatOpenAI({
      apiKey: settings.token,
      model: modelData?.spec?.runtime?.model,
      configuration: {
        baseURL: `${url}/v1`,
      },
      ...options,
    });
  } catch (err) {
    handleDynamicImportError(err);
    throw err;
  }
};
