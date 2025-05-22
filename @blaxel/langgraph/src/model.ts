import { authenticate, getModelMetadata, handleDynamicImportError, settings } from "@blaxel/core";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatCohere } from "@langchain/cohere";
import { LanguageModelLike } from "@langchain/core/language_models/base";
import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatOpenAI } from "@langchain/openai";
import { CohereClient } from "cohere-ai";
import { ChatGoogleGenerativeAI } from "./model/google-genai/index.js";
import { ChatXAI } from "./model/xai.js";

export const blModel = async (
  model: string,
  options?: Record<string, unknown>
): Promise<LanguageModelLike> => {
  const url = `${settings.runUrl}/${settings.workspace}/models/${model}`;
  const modelData = await getModelMetadata(model);
  if (!modelData) {
    throw new Error(`Model ${model} not found`);
  }
  await authenticate();
  const type = modelData?.spec?.runtime?.type || "openai";
  try {
    if (type === "gemini") {

      return new ChatGoogleGenerativeAI({
        apiKey: settings.token,
        model: modelData?.spec?.runtime?.model,
        baseUrl: url,
        customHeaders: settings.headers,
        ...options,
      });
    } else if (type === "mistral") {

      return new ChatOpenAI({
        apiKey: settings.token,
        model: modelData?.spec?.runtime?.model,
        configuration: {
          baseURL: `${url}/v1`,
        },
        ...options,
      });
    } else if (type === "cohere") {

      return new ChatCohere({
        apiKey: settings.token,
        model: modelData?.spec?.runtime?.model,
        client: new CohereClient({
          token: settings.token,
          environment: url,
        }),
      });
    } else if (type === "deepseek") {

      return new ChatDeepSeek({
        apiKey: settings.token,
        model: modelData?.spec?.runtime?.model,
        configuration: {
          baseURL: `${url}/v1`,
        },
        ...options,
      });
    } else if (type === "anthropic") {

      return new ChatAnthropic({
        anthropicApiUrl: url,
        model: modelData?.spec?.runtime?.model,
        clientOptions: {
          defaultHeaders: settings.headers,
        },
        ...options,
      });
    } else if (type === "xai") {

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

      return new ChatOpenAI({
        apiKey: settings.token,
        model: modelData?.spec?.runtime?.model,
        configuration: {
          baseURL: `${url}/v1`,
        },
        ...options,
      });
    }
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
