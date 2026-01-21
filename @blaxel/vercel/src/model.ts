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
  const type = modelData?.spec.runtime?.type || "openai";
  const modelId = modelData?.spec.runtime?.model || "gpt-4o";

  // Custom fetch function that refreshes authentication on each request
  const authenticatedFetch = async (input: string | URL | Request, init?: RequestInit) => {
    await authenticate();

    // Properly extract headers from init, handling Headers object, plain object, or array
    let existingHeaders: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        // Headers object - iterate to extract all headers
        init.headers.forEach((value, key) => {
          existingHeaders[key] = value;
        });
      } else if (Array.isArray(init.headers)) {
        // Array of [key, value] pairs
        for (const [key, value] of init.headers) {
          existingHeaders[key] = value;
        }
      } else {
        // Plain object
        existingHeaders = { ...(init.headers as Record<string, string>) };
      }
    }

    // Remove the SDK's authorization header since we use x-blaxel-authorization
    // The SDK sets "Authorization: Bearer replaced" which would be rejected by the server
    delete existingHeaders['authorization'];
    delete existingHeaders['Authorization'];

    const headers = {
      ...existingHeaders,
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
          // Properly extract headers from options, handling Headers object
          let existingHeaders: Record<string, string> = {};
          if (options?.headers) {
            if (options.headers instanceof Headers) {
              options.headers.forEach((value, key) => {
                existingHeaders[key] = value;
              });
            } else if (Array.isArray(options.headers)) {
              for (const [key, value] of options.headers) {
                existingHeaders[key] = value;
              }
            } else {
              existingHeaders = { ...(options.headers as Record<string, string>) };
            }
          }
          // Remove the SDK's authorization header since we use x-blaxel-authorization
          delete existingHeaders['authorization'];
          delete existingHeaders['Authorization'];

          const headers = {
            ...existingHeaders,
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
