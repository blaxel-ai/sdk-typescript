import { Serialized } from "@langchain/core/load/serializable";
import { type LangSmithParams } from "@langchain/core/language_models/chat_models";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { ChatOpenAI } from "@langchain/openai";

/**
 * Extends the ChatOpenAI class to create a ChatXAI agent with additional configurations.
 */
export class ChatXAI extends ChatOpenAI {
  /**
   * Returns the name of the class for LangChain serialization.
   * @returns The class name as a string.
   */
  static lc_name() {
    return "ChatXAI";
  }

  /**
   * Specifies the type of the language model.
   * @returns The type of the LLM as a string.
   */
  _llmType() {
    return "xAI";
  }

  /**
   * Specifies the secrets required for serialization.
   * @returns An object mapping secret names to their keys.
   */
  get lc_secrets() {
    return {
      apiKey: "XAI_API_KEY",
    };
  }

  /**
   * Constructs a new ChatXAI instance.
   * @param fields - Configuration fields, including the API key.
   * @throws If the API key is not provided.
   */
  constructor(fields: Record<string, unknown>) {
    const apiKey = fields?.apiKey || getEnvironmentVariable("XAI_API_KEY");
    if (!apiKey) {
      throw new Error(
        `xAI API key not found. Please set the XAI_API_KEY environment variable or provide the key into "apiKey" field.`
      );
    }
    super(fields);
    Object.defineProperty(this, "lc_serializable", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: true,
    });
    Object.defineProperty(this, "lc_namespace", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: ["langchain", "chat_models", "xai"],
    });
  }

  /**
   * Serializes the instance to JSON, removing sensitive information.
   * @returns The serialized JSON object.
   */
  toJSON(): Serialized {
    const result = super.toJSON();
    if (
      "kwargs" in result &&
      typeof result.kwargs === "object" &&
      result.kwargs != null
    ) {
      delete result.kwargs.openai_api_key;
      delete result.kwargs.configuration;
    }
    return result;
  }

  /**
   * Retrieves parameters for LangChain based on provided options.
   * @param options - Additional options for parameter retrieval.
   * @returns An object containing LangChain parameters.
   */
  getLsParams(options: unknown): LangSmithParams {
    const params = super.getLsParams(options as this["ParsedCallOptions"]);
    params.ls_provider = "xai";
    return params;
  }
}
