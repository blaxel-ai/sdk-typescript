import { authenticate, getModelMetadata, handleDynamicImportError, settings } from "@blaxel/core";
import { anthropic, AnthropicSession } from "@llamaindex/anthropic";
import type { ChatResponse, ChatResponseChunk, CompletionResponse, LLMChatParamsNonStreaming, LLMChatParamsStreaming, LLMCompletionParamsNonStreaming, LLMCompletionParamsStreaming, LLMMetadata, ToolCallLLM, ToolCallLLMMessageOptions } from '@llamaindex/core/llms' with { "resolution-mode": "import" };
import { ZodSchema } from '@llamaindex/core/zod';
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
    this.type = modelData?.spec.runtime?.type || "openai";
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
      try {
        const llm = await this.createLLM();
        this._metadata = llm.metadata;
      } catch {
        // If metadata access fails (e.g., Gemini), use default metadata
        this._metadata = {
          model: this.modelData?.spec.runtime?.model || this.model,
          temperature: this.options?.temperature as number | undefined ?? 0,
          topP: this.options?.topP as number | undefined ?? 1,
          maxTokens: this.options?.maxTokens as number | undefined ?? undefined,
          contextWindow: this.options?.contextWindow as number | undefined ?? 4096,
          tokenizer: undefined,
          structuredOutput: (this.options?.structuredOutput as boolean | undefined) ?? false,
        };
      }
    }
  }

  private async createLLM(): Promise<ToolCallLLM<object, ToolCallLLMMessageOptions>> {
    await authenticate();
    // Capture fresh headers and token after authentication
    // Use getter to ensure we get the latest values
    const currentToken = settings.token;
    const url = `${settings.runUrl}/${settings.workspace}/models/${this.model}`;

    // Custom fetch function that adds authentication headers
    const authenticatedFetch = async (input: string | URL | Request, init?: RequestInit) => {
      await authenticate();
      // Get fresh headers after authentication
      const freshHeaders = { ...settings.headers };
      const headers: Record<string, string> = {
        ...freshHeaders,
        ...(init?.headers as Record<string, string> || {}),
      };

      // Ensure Content-Type is set for JSON requests if body exists and Content-Type is not already set
      if (init?.body && !headers['Content-Type'] && !headers['content-type']) {
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

      return fetch(input, {
        ...init,
        headers,
      });
    };

    if (this.type === "mistral") {
      return openai({
        model: this.modelData?.spec.runtime?.model,
        apiKey: currentToken,
        baseURL: `${url}/v1`,
        additionalSessionOptions: {
          fetch: authenticatedFetch,
        },
        ...this.options,
      }) as unknown as ToolCallLLM<object, ToolCallLLMMessageOptions>;
    }

    if (this.type === "anthropic") {
      // Set a dummy API key to satisfy AnthropicSession constructor requirement
      // The actual authentication is handled via defaultHeaders
      process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy-key-for-blaxel";
      // Get fresh headers right before creating the session
      const anthropicHeaders = { ...settings.headers };
      const llm = anthropic({
        model: this.modelData?.spec.runtime?.model,
        session: new AnthropicSession({
          baseURL: url,
          defaultHeaders: anthropicHeaders,
        }),
        ...this.options,
      });

      // Wrap the LLM to normalize Anthropic's response format (array content -> string)
      // Create overloaded chat function
      const chatWrapper = async (
        params: LLMChatParamsStreaming<object, ToolCallLLMMessageOptions> | LLMChatParamsNonStreaming<object, ToolCallLLMMessageOptions>
      ): Promise<AsyncIterable<ChatResponseChunk<object>> | ChatResponse<ToolCallLLMMessageOptions>> => {
        // Type guard to determine if params is streaming or non-streaming
        const isStreaming = 'stream' in params && params.stream === true;

        let response: AsyncIterable<ChatResponseChunk<object>> | ChatResponse<ToolCallLLMMessageOptions>;
        if (isStreaming) {
          response = await llm.chat(params);
        } else {
          response = await llm.chat(params);
        }

        // Handle streaming responses (AsyncIterable)
        const isAsyncIterable = (value: unknown): value is AsyncIterable<ChatResponseChunk<object>> => {
          return value !== null && typeof value === 'object' && Symbol.asyncIterator in value;
        };

        if (isAsyncIterable(response)) {
          return response; // Streaming responses are handled differently, return as-is
        }

        // Transform array content to string for non-streaming responses
        const chatResponse = response;
        if (chatResponse && typeof chatResponse === 'object' && chatResponse !== null && 'message' in chatResponse) {
          if (chatResponse.message && Array.isArray(chatResponse.message.content)) {
            const contentArray = chatResponse.message.content as Array<{ type?: string; text?: string }>;
            const textContent = contentArray
              .filter((item) => item.type === 'text' && item.text)
              .map((item) => item.text)
              .join('');
            return {
              ...chatResponse,
              message: {
                ...chatResponse.message,
                content: textContent || chatResponse.message.content,
              },
            };
          }
        }
        return chatResponse;
      };

      // Add overload signatures
      const chatWithOverloads = chatWrapper as {
        (params: LLMChatParamsStreaming<object, ToolCallLLMMessageOptions>): Promise<AsyncIterable<ChatResponseChunk<object>>>;
        (params: LLMChatParamsNonStreaming<object, ToolCallLLMMessageOptions>): Promise<ChatResponse<ToolCallLLMMessageOptions>>;
      };

      const wrappedLLM: ToolCallLLM<object, ToolCallLLMMessageOptions> = {
        ...llm,
        supportToolCall: true,
        chat: chatWithOverloads,
        complete: llm.complete.bind(llm),
        exec: llm.exec.bind(llm),
        streamExec: llm.streamExec.bind(llm),
        metadata: llm.metadata,
      };

      return wrappedLLM;
    }

    if (this.type === "cohere") {
      const llm = openai({
        model: this.modelData?.spec.runtime?.model,
        apiKey: currentToken,
        baseURL: `${url}/compatibility/v1`, // OpenAI compatibility endpoint
        additionalSessionOptions: {
          fetch: authenticatedFetch,
        },
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
        model: this.modelData?.spec.runtime?.model as GEMINI_MODEL,
        httpOptions: {
          baseUrl: url,
          headers: settings.headers,
        },
        ...this.options,
      });
      return llm as unknown as ToolCallLLM<object, ToolCallLLMMessageOptions>;
    }

    return openai({
      model: this.modelData?.spec.runtime?.model,
      apiKey: currentToken,
      baseURL: `${url}/v1`,
      additionalSessionOptions: {
        fetch: authenticatedFetch,
      },
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

  // Overloaded exec method
  async exec<Z extends ZodSchema>(params: LLMChatParamsStreaming<object, ToolCallLLMMessageOptions, Z>): Promise<any>;
  async exec<Z extends ZodSchema>(params: LLMChatParamsNonStreaming<object, ToolCallLLMMessageOptions, Z>): Promise<any>;
  async exec<Z extends ZodSchema>(params: LLMChatParamsStreaming<object, ToolCallLLMMessageOptions, Z> | LLMChatParamsNonStreaming<object, ToolCallLLMMessageOptions, Z>): Promise<any> {
    await this.ensureMetadata();
    const llm = await this.createLLM();
    // Type guard to handle overloads
    if ('stream' in params && params.stream === true) {
      return llm.exec(params);
    } else {
      return llm.exec(params);
    }
  }

  // streamExec method
  async streamExec<Z extends ZodSchema>(params: LLMChatParamsStreaming<object, ToolCallLLMMessageOptions, Z>): Promise<any> {
    await this.ensureMetadata();
    const llm = await this.createLLM();
    return llm.streamExec(params);
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
