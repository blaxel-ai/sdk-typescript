import { createAnthropic } from "@ai-sdk/anthropic";
import { createCerebras } from "@ai-sdk/cerebras";
import { createCohere } from "@ai-sdk/cohere";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { authenticate, getModelMetadata, handleDynamicImportError, settings } from "@blaxel/core";

export const blModel = async (
  model: string,
  options?: Record<string, unknown>
): Promise<ReturnType<ReturnType<typeof createOpenAI>>> => {
  const url = `${settings.runUrl}/${settings.workspace}/models/${model}`;
  const modelData = await getModelMetadata(model);
  if (!modelData) {
    throw new Error(`Model ${model} not found`);
  }
  await authenticate();
  const type = modelData?.spec?.runtime?.type || "openai";
  const modelId = modelData?.spec?.runtime?.model || "gpt-4o";

  // Custom fetch function that refreshes authentication on each request
  const authenticatedFetch = async (input: string | URL | Request, init?: RequestInit) => {
    await authenticate();
    const headers = {
      ...init?.headers,
      ...settings.headers,
    };
    return fetch(input, {
      ...init,
      headers,
    });
  };
  try {
    if (type === "gemini") {
      return createGoogleGenerativeAI({
        apiKey: "replaced",
        fetch: async (_, options) => {
          await authenticate();
          const headers = {
            ...options?.headers,
            ...settings.headers,
          };
          return fetch(`${url}/v1beta/models/${modelId}:generateContent`, {
            ...options,
            headers,
          })
        },
        ...options,
      })(modelId);
    } else if (type === "anthropic") {
      return createAnthropic({
        apiKey: "replaced",
        baseURL: `${url}/v1`,
        fetch: authenticatedFetch,
        ...options,
      })(modelId);
    } else if (type === "groq") {
      return createGroq({
        apiKey: "replaced",
        baseURL: `${url}`,
        fetch: authenticatedFetch,
        ...options,
      })(modelId);
    } else if (type === "cerebras") {
      return createCerebras({
        apiKey: "replaced",
        baseURL: `${url}/v1`,
        fetch: authenticatedFetch,
        ...options,
      })(modelId);
    } else if (type === "cohere") {
      return createCohere({
        apiKey: "replaced",
        baseURL: `${url}/v2`,
        fetch: authenticatedFetch,
        ...options,
      })(modelId);
    } else if (type === "mistral") {
      return createMistral({
        apiKey: "replaced",
        baseURL: `${url}/v1`,
        fetch: authenticatedFetch,
        ...options,
      })(modelId);
    } else if (type === "deepseek") {
      return createDeepSeek({
        apiKey: "replaced",
        baseURL: `${url}/v1`,
        fetch: authenticatedFetch,
        ...options,
      })(modelId);
    }

    return createOpenAI({
      apiKey: "replaced",
      baseURL: `${url}/v1`,
      fetch: authenticatedFetch,
      ...options,
    })(modelId);
  } catch (err) {
    handleDynamicImportError(err);
    throw err;
  }
};
