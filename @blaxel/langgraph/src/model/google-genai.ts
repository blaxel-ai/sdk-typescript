import { authenticate, settings } from "@blaxel/core";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseMessage } from "@langchain/core/messages";
import { ChatResult } from "@langchain/core/outputs";
import { ChatGoogleGenerativeAI } from "./google-genai/index.js";

/**
 * Custom ChatGoogleGenerativeAI that ensures authentication before each request
 */
export class AuthenticatedChatGoogleGenerativeAI extends ChatGoogleGenerativeAI {
  async _generate(
    messages: BaseMessage[],
    options?: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    // Authenticate before making the request
    await authenticate();
    this.customHeaders = {};
    for (const header in settings.headers) {
      this.customHeaders[header] = settings.headers[header];
    }
    this.client = this.initClient();
    return await super._generate(messages, options || {} as this["ParsedCallOptions"], runManager);
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options?: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<any> {
    // Authenticate before making the request
    await authenticate();
    this.customHeaders = {};
    for (const header in settings.headers) {
      this.customHeaders[header] = settings.headers[header];
    }

    yield* super._streamResponseChunks(messages, options || {} as this["ParsedCallOptions"], runManager);
  }
}