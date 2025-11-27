import { authenticate, settings } from "@blaxel/core";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import { BaseMessage } from "@langchain/core/messages";
import { AIMessageChunk } from "@langchain/core/messages";
import { ChatResult, ChatGenerationChunk } from "@langchain/core/outputs";
import { Runnable } from "@langchain/core/runnables";
import { ChatGoogleGenerativeAI, GoogleGenerativeAIChatCallOptions, GoogleGenerativeAIChatInput } from "@langchain/google-genai";
import { GoogleGenerativeAI as GenerativeAI, GenerativeModel, SafetySetting, RequestOptions } from "@google/generative-ai";

// Extract GoogleGenerativeAIToolType from GoogleGenerativeAIChatCallOptions
type GoogleGenerativeAIToolType = NonNullable<GoogleGenerativeAIChatCallOptions["tools"]>[number];

/**
 * Custom ChatGoogleGenerativeAI that ensures authentication before each request
 * and supports custom headers without modifying the library code
 */
export class AuthenticatedChatGoogleGenerativeAI extends ChatGoogleGenerativeAI {
  private customHeaders?: Record<string, string>;
  private constructorParams: {
    apiKey?: string;
    apiVersion?: string;
    baseUrl?: string;
    model: string;
    safetySettings?: SafetySetting[];
    stopSequences?: string[];
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    json?: boolean;
    thinkingConfig?: unknown;
  };

  constructor(fields: GoogleGenerativeAIChatInput & { customHeaders?: Record<string, string> }) {
    super(fields);

    // Store constructor parameters for recreating the client
    this.constructorParams = {
      apiKey: fields.apiKey,
      apiVersion: fields.apiVersion,
      baseUrl: fields.baseUrl,
      model: fields.model,
      safetySettings: fields.safetySettings,
      stopSequences: fields.stopSequences,
      maxOutputTokens: fields.maxOutputTokens,
      temperature: fields.temperature,
      topP: fields.topP,
      topK: fields.topK,
      json: fields.json,
      thinkingConfig: (fields as { thinkingConfig?: unknown }).thinkingConfig,
    };

    this.customHeaders = fields.customHeaders;

    // Initialize client with custom headers if provided
    if (this.customHeaders) {
      this.recreateClient();
    }
  }

  /**
   * Recreates the client with updated custom headers
   * Uses type assertion to access the private client property
   */
  private recreateClient(): void {
    const apiKey = this.constructorParams.apiKey || (this as unknown as { apiKey?: string }).apiKey;
    if (!apiKey) return;

    // Get the processed model name from the base class (it removes "models/" prefix)
    const model = (this as unknown as { model: string }).model || this.constructorParams.model.replace(/^models\//, "");

    const modelParams = {
      model,
      safetySettings: this.constructorParams.safetySettings as SafetySetting[],
      generationConfig: {
        candidateCount: 1,
        stopSequences: this.constructorParams.stopSequences,
        maxOutputTokens: this.constructorParams.maxOutputTokens,
        temperature: this.constructorParams.temperature,
        topP: this.constructorParams.topP,
        topK: this.constructorParams.topK,
        ...(this.constructorParams.json ? { responseMimeType: "application/json" as const } : {}),
        ...(this.constructorParams.thinkingConfig
          ? { thinkingConfig: this.constructorParams.thinkingConfig }
          : {}),
      },
    };

    const requestOptions: RequestOptions = {
      apiVersion: this.constructorParams.apiVersion,
      baseUrl: this.constructorParams.baseUrl,
      customHeaders: this.customHeaders,
    };

    // Use type assertion to access private client property
    (this as unknown as { client: GenerativeModel }).client = new GenerativeAI(apiKey).getGenerativeModel(
      modelParams,
      requestOptions
    );
  }

  async _generate(
    messages: BaseMessage[],
    options?: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    // Authenticate before making the request
    await authenticate();

    // Update custom headers from settings
    this.customHeaders = { ...settings.headers };

    // Recreate client with updated headers
    this.recreateClient();

    return await super._generate(messages, options || {} as this["ParsedCallOptions"], runManager);
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    // Authenticate before making the request
    await authenticate();

    // Update custom headers from settings
    this.customHeaders = { ...settings.headers };

    // Recreate client with updated headers
    this.recreateClient();

    yield* super._streamResponseChunks(messages, options, runManager);
  }

  override bindTools(
    tools: GoogleGenerativeAIToolType[],
    kwargs?: Partial<GoogleGenerativeAIChatCallOptions>
  ): Runnable<
    BaseLanguageModelInput,
    AIMessageChunk,
    GoogleGenerativeAIChatCallOptions
  > {
    return super.bindTools(tools, kwargs);
  }
}
