import { authenticate, getModelMetadata, handleDynamicImportError, settings } from "@blaxel/core";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatCohere } from "@langchain/cohere";
import { LanguageModelLike } from "@langchain/core/language_models/base";
import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatOpenAI } from "@langchain/openai";
import { CohereClient } from "cohere-ai";
import { createCohereFetcher } from "./model/cohere.js";
import { AuthenticatedChatGoogleGenerativeAI } from "./model/google-genai.js";
import { ChatXAI } from "./model/xai.js";

/**
 * Creates a custom fetch function that adds dynamic headers to each request
 * Returns a function compatible with OpenAI SDK's fetch option
 */
const authenticatedFetch = () => {
  const customFetch: any = async (input: string | URL | Request, init?: RequestInit) => {
    await authenticate();
    const dynamicHeaders = settings.headers;

    // Merge headers: init headers take precedence over dynamic headers
    const headers = {
      ...dynamicHeaders,
      ...(init?.headers as Record<string, string> || {}),
    };

    // Make the request with merged headers
    return await fetch(input, {
      ...init,
      headers,
    });
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return customFetch;
};

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
      return new AuthenticatedChatGoogleGenerativeAI({
        apiKey: settings.token,
        model: modelData?.spec?.runtime?.model,
        baseUrl: url,
        customHeaders: settings.headers,
        ...options,
      });
    } else if (type === "mistral") {
      return new ChatOpenAI({
        apiKey: "replaced",
        model: modelData?.spec?.runtime?.model,
        configuration: {
          baseURL: `${url}/v1`,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          fetch: authenticatedFetch(),
        },
        ...options,
      });
    } else if (type === "cohere") {
      return new ChatCohere({
        apiKey: "replaced",
        model: modelData?.spec?.runtime?.model,
        client: new CohereClient({
          token: "replaced",
          environment: url,
          fetcher: createCohereFetcher(),
        }),
        ...options,
      });
    } else if (type === "deepseek") {
      return new ChatDeepSeek({
        apiKey: "replaced",
        model: modelData?.spec?.runtime?.model,
        configuration: {
          baseURL: `${url}/v1`,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          fetch: authenticatedFetch(),
        },
        ...options,
      });
    } else if (type === "anthropic") {
      return new ChatAnthropic({
        anthropicApiUrl: url,
        model: modelData?.spec?.runtime?.model,
        clientOptions: {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          fetch: authenticatedFetch(),
        },
        ...options,
      });
    } else if (type === "xai") {

      return new ChatXAI({
        apiKey: "replaced",
        configuration: {
          baseURL: `${url}/v1`,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          fetch: authenticatedFetch(),
        },
        model: modelData?.spec?.runtime?.model,
        ...options,
      });
    } else if (type === "cerebras") {
      // We don't use ChatCerebras because there is a problem with apiKey headers

      return new ChatOpenAI({
        apiKey: "replaced",
        model: modelData?.spec?.runtime?.model,
        configuration: {
          baseURL: `${url}/v1`,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          fetch: authenticatedFetch(),
        },
        ...options,
      });
    }
    return new ChatOpenAI({
      apiKey: "replaced",
      model: modelData?.spec?.runtime?.model,
      configuration: {
        baseURL: `${url}/v1`,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        fetch: authenticatedFetch(),
      },
      ...options,
    });
  } catch (err) {
    handleDynamicImportError(err);
    throw err;
  }
};
