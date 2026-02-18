import { authenticate, getModelMetadata, handleDynamicImportError, settings } from "@blaxel/core";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatCohere } from "@langchain/cohere";
import { LanguageModelLike } from "@langchain/core/language_models/base";
import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatOpenAI } from "@langchain/openai";
import { AuthenticatedChatGoogleGenerativeAI } from "./model/google-genai.js";
import { CohereClient } from "cohere-ai";
import { createCohereFetcher } from "./model/cohere.js";
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
    const headers: Record<string, string> = {
      ...dynamicHeaders,
      ...(init?.headers as Record<string, string> || {}),
    };

    // Ensure Content-Type is set for JSON requests if body exists and Content-Type is not already set
    if (init?.body && !headers['Content-Type'] && !headers['content-type']) {
      // If body is an object, it will be serialized to JSON by fetch
      // If body is a string, check if it looks like JSON
      if (typeof init.body === 'string') {
        const trimmed = init.body.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          headers['Content-Type'] = 'application/json';
        }
      } else {
        // For non-string bodies (FormData, Blob, etc.), let fetch handle it
        // For objects, assume JSON
        if (typeof init.body === 'object' && !(init.body instanceof FormData) && !(init.body instanceof Blob)) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }

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
  const modelData = await getModelMetadata(model);
  if (!modelData) {
    throw new Error(`Model ${model} not found`);
  }
  await authenticate();

  // mk3 models use the direct gateway URL and always speak OpenAI-compatible API
  if (modelData.spec.runtime?.generation === "mk3") {
    const gatewayUrl = modelData.metadata.url;
    if (!gatewayUrl) {
      throw new Error(`Model ${model} is mk3 but has no gateway URL in metadata`);
    }

    return new ChatOpenAI({
      apiKey: "replaced",
      model: model,
      configuration: {
        baseURL: `${gatewayUrl}/v1`,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        fetch: authenticatedFetch(),
      },
      ...options,
    });
  }

  const url = `${settings.runUrl}/${settings.workspace}/models/${model}`;
  const type = modelData.spec.runtime?.type || "openai";
  try {
    if (type === "gemini") {
      return new AuthenticatedChatGoogleGenerativeAI({
        apiKey: settings.token,
        model: modelData.spec.runtime?.model as string,
        baseUrl: url,
        customHeaders: settings.headers,
        ...options,
      });
    } else if (type === "mistral") {
      return new ChatOpenAI({
        apiKey: "replaced",
        model: modelData.spec.runtime?.model,
        configuration: {
          baseURL: `${url}/v1`,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          fetch: authenticatedFetch(),
        },
        ...options,
      });
    } else if (type === "cohere") {
      // ChatCohere requires a custom client with fetcher for:
      // 1. Dynamic authentication headers (settings.headers)
      // 2. Custom environment URL (url)
      // 3. URL rewriting (v1 -> v2) and body transformation for v2 compatibility
      // @ts-ignore Error in langgraph
      return new ChatCohere({
        apiKey: "replaced",
        model: modelData.spec.runtime?.model,
        client: new CohereClient({
          token: "replaced",
          environment: url,
          fetcher: createCohereFetcher(),
        }),
        ...options,
      });
    } else if (type === "deepseek") {
      // @ts-ignore Error in langgraph
      return new ChatDeepSeek({
        apiKey: "replaced",
        model: modelData.spec.runtime?.model,
        configuration: {
          baseURL: `${url}/v1`,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          fetch: authenticatedFetch(),
        },
        ...options,
      });
    } else if (type === "anthropic") {
      // @ts-ignore Error in langgraph
      return new ChatAnthropic({
        anthropicApiUrl: url,
        model: modelData.spec.runtime?.model,
        apiKey: "replaced",
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
        model: modelData.spec.runtime?.model,
        ...options,
      });
    } else if (type === "cerebras") {
      // We don't use ChatCerebras because there is a problem with apiKey headers
      return new ChatOpenAI({
        apiKey: "replaced",
        model: modelData.spec.runtime?.model,
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
      model: modelData.spec.runtime?.model,
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
