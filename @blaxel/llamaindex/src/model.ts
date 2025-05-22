import { authenticate, getModelMetadata, handleDynamicImportError, settings } from "@blaxel/core";
import { anthropic, AnthropicSession } from "@llamaindex/anthropic";
import type { ToolCallLLM, ToolCallLLMMessageOptions } from '@llamaindex/core/llms' with { "resolution-mode": "import" };
import { Gemini, GEMINI_MODEL } from "@llamaindex/google";
import { openai } from "@llamaindex/openai";



export const blModel = async (
  model: string,
  options?: Record<string, unknown>
): Promise<ToolCallLLM<object, ToolCallLLMMessageOptions>> => {
  const url = `${settings.runUrl}/${settings.workspace}/models/${model}`;
  const modelData = await getModelMetadata(model);
  if (!modelData) {
    throw new Error(`Model ${model} not found`);
  }
  await authenticate();
  const type = modelData?.spec?.runtime?.type || "openai";
  try {
    if (type === "mistral") {
      return openai({
        model: modelData?.spec?.runtime?.model,
        apiKey: settings.token,
        baseURL: `${url}/v1`,
        ...options,
      }) as unknown as ToolCallLLM<object, ToolCallLLMMessageOptions>;
    }

    if (type === "anthropic") {

      const llm = anthropic({
        model: modelData?.spec?.runtime?.model,
        session: new AnthropicSession({
          baseURL: url,
          defaultHeaders: settings.headers,
        }),
        ...options,
      });
      return {
        ...llm,
        supportToolCall: true,
      } as unknown as ToolCallLLM<object, ToolCallLLMMessageOptions>;
    }

    if (type === "cohere") {
      const llm = openai({
        model: modelData?.spec?.runtime?.model,
        apiKey: settings.token,
        baseURL: `${url}/compatibility/v1`,
        ...options,
      });
      return {
        ...llm,
        supportToolCall: true,
      } as unknown as ToolCallLLM<object, ToolCallLLMMessageOptions>;
    }

    if (type === "gemini") {
      process.env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "THIS_IS_A_DUMMY_KEY_FOR_LLAMAINDEX";
      const llm = new Gemini({
        apiKey: settings.token,
        model: modelData?.spec?.runtime?.model as GEMINI_MODEL,
        requestOptions:{
          baseUrl: url,
          customHeaders: settings.headers,
        },
        ...options,
      });
      return llm as unknown as ToolCallLLM<object, ToolCallLLMMessageOptions>
    }

    return openai({
      model: modelData?.spec?.runtime?.model,
      apiKey: settings.token,
      baseURL: `${url}/v1`,
      ...options,
    }) as unknown as ToolCallLLM<object, ToolCallLLMMessageOptions>;
  } catch (err) {
    handleDynamicImportError(err);
    throw err;
  }
};
