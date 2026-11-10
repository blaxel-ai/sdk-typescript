import type { ChatOpenAICallOptions } from "@langchain/openai";
import { ChatOpenAI } from "@langchain/openai";

/**
 * ChatOpenAI for mk3 OpenAI models, which are addressed by their Blaxel name so
 * LangChain cannot detect the upstream model. Reasoning-only models (e.g.
 * gpt-6-astra) reject function tools on /v1/chat/completions, so tool calls go
 * through /v1/responses. Plain calls stay on Chat Completions to keep `content`
 * a string.
 */
export class ChatBlaxelOpenAI extends ChatOpenAI {
  protected _useResponsesApi(options: this["ParsedCallOptions"] | undefined): boolean {
    const tools = this._combineCallOptions(options).tools;
    return super._useResponsesApi(options) || (tools?.length ?? 0) > 0;
  }

  // ChatOpenAI.withConfig (used by bindTools) rebuilds a plain ChatOpenAI; keep this class.
  withConfig(config: Partial<ChatOpenAICallOptions>) {
    const model = new ChatBlaxelOpenAI(this.fields);
    model.defaultOptions = { ...this.defaultOptions, ...config };
    return model;
  }
}
