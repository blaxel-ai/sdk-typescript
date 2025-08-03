import { authenticate, getModelMetadata, handleDynamicImportError, settings } from "@blaxel/core";
import { anthropic, AnthropicSession } from "@llamaindex/anthropic";
import type { ChatResponse, ChatResponseChunk, CompletionResponse, LLMChatParamsNonStreaming, LLMChatParamsStreaming, LLMCompletionParamsNonStreaming, LLMCompletionParamsStreaming, LLMMetadata, ToolCallLLM, ToolCallLLMMessageOptions } from '@llamaindex/core/llms' with { "resolution-mode": "import" };
import { Gemini, GEMINI_MODEL } from "@llamaindex/google";
import { openai } from "@llamaindex/openai";

// Type for model metadata
interface ModelData {
  spec?: {
    runtime?: {
      type?: string;
      model?: string;
    };
  };
}

// Custom LLM provider that refreshes auth on each call
class BlaxelLLM implements ToolCallLLM<object, ToolCallLLMMessageOptions> {
  private model: string;
  private options?: Record<string, unknown>;
  private modelData: ModelData;
  private type: string;
  private _metadata?: LLMMetadata;

  constructor(model: string, modelData: ModelData, options?: Record<string, unknown>) {
    this.model = model;
    this.modelData = modelData;
    this.options = options;
    this.type = modelData?.spec?.runtime?.type || "openai";
  }

  get supportToolCall(): boolean {
    return true;
  }

  get metadata(): LLMMetadata {
    // Return cached metadata or default values
    if (this._metadata) {
      return this._metadata;
    }

    // Return default values with overrides from options
    return {
      model: this.model,
      temperature: this.options?.temperature as number | undefined ?? 0,
      topP: this.options?.topP as number | undefined ?? 1,
      maxTokens: this.options?.maxTokens as number | undefined ?? undefined,
      contextWindow: this.options?.contextWindow as number | undefined ?? 4096,
      tokenizer: undefined, // Let the underlying LLM handle tokenizer
      structuredOutput: (this.options?.structuredOutput as boolean | undefined) ?? false,
    };
  }

  private async ensureMetadata(): Promise<void> {
    if (!this._metadata) {
      const llm = await this.createLLM();
      this._metadata = llm.metadata;
    }
  }

  private async createLLM(): Promise<ToolCallLLM<object, ToolCallLLMMessageOptions>> {
    await authenticate();
    const url = `${settings.runUrl}/${settings.workspace}/models/${this.model}`;

    if (this.type === "mistral") {
      return openai({
        model: this.modelData?.spec?.runtime?.model,
        apiKey: settings.token,
        baseURL: `${url}/v1`,
        ...this.options,
      }) as unknown as ToolCallLLM<object, ToolCallLLMMessageOptions>;
    }

    if (this.type === "anthropic") {
      const llm = anthropic({
        model: this.modelData?.spec?.runtime?.model,
        session: new AnthropicSession({
          baseURL: url,
          defaultHeaders: settings.headers,
        }),
        ...this.options,
      });
      return {
        ...llm,
        supportToolCall: true,
      } as unknown as ToolCallLLM<object, ToolCallLLMMessageOptions>;
    }

    if (this.type === "cohere") {
      const llm = openai({
        model: this.modelData?.spec?.runtime?.model,
        apiKey: settings.token,
        baseURL: `${url}/compatibility/v1`,
        ...this.options,
      });
      return {
        ...llm,
        supportToolCall: true,
      } as unknown as ToolCallLLM<object, ToolCallLLMMessageOptions>;
    }

    if (this.type === "gemini") {
      process.env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "THIS_IS_A_DUMMY_KEY_FOR_LLAMAINDEX";
      const llm = new Gemini({
        apiKey: settings.token,
        model: this.modelData?.spec?.runtime?.model as GEMINI_MODEL,
        httpOptions: {
          baseUrl: url,
          headers: settings.headers,
        },
        ...this.options,
      });
      return llm as unknown as ToolCallLLM<object, ToolCallLLMMessageOptions>;
    }

    return openai({
      model: this.modelData?.spec?.runtime?.model,
      apiKey: settings.token,
      baseURL: `${url}/v1`,
      ...this.options,
    }) as unknown as ToolCallLLM<object, ToolCallLLMMessageOptions>;
  }

  // Overloaded chat method
  async chat(params: LLMChatParamsStreaming<object, ToolCallLLMMessageOptions>): Promise<AsyncIterable<ChatResponseChunk<object>>>;
  async chat(params: LLMChatParamsNonStreaming<object, ToolCallLLMMessageOptions>): Promise<ChatResponse<ToolCallLLMMessageOptions>>;
  async chat(params: LLMChatParamsStreaming<object, ToolCallLLMMessageOptions> | LLMChatParamsNonStreaming<object, ToolCallLLMMessageOptions>): Promise<AsyncIterable<ChatResponseChunk<object>> | ChatResponse<ToolCallLLMMessageOptions>> {
    await this.ensureMetadata();
    const llm = await this.createLLM();

    // Type guard to handle overloads
    if ('stream' in params && params.stream === true) {
      return llm.chat(params);
    } else {
      return llm.chat(params);
    }
  }

  // Overloaded complete method
  async complete(params: LLMCompletionParamsStreaming): Promise<AsyncIterable<CompletionResponse>>;
  async complete(params: LLMCompletionParamsNonStreaming): Promise<CompletionResponse>;
  async complete(params: LLMCompletionParamsStreaming | LLMCompletionParamsNonStreaming): Promise<AsyncIterable<CompletionResponse> | CompletionResponse> {
    await this.ensureMetadata();
    const llm = await this.createLLM();

    // Type guard to handle overloads
    if ('stream' in params && params.stream === true) {
      return llm.complete(params);
    } else {
      return llm.complete(params);
    }
  }
}

export const blModel = async (
  model: string,
  options?: Record<string, unknown>
): Promise<ToolCallLLM<object, ToolCallLLMMessageOptions>> => {
  const modelData = await getModelMetadata(model);
  if (!modelData) {
    throw new Error(`Model ${model} not found`);
  }

  try {
    return new BlaxelLLM(model, modelData as ModelData, options);
  } catch (err) {
    handleDynamicImportError(err);
    throw err;
  }
};
