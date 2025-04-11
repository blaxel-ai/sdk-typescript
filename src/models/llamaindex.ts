import { anthropic, AnthropicSession } from "@llamaindex/anthropic";
import { mistral } from "@llamaindex/mistral";
import { openai } from "@llamaindex/openai";
import { onLoad } from "../common/autoload";
import settings from "../common/settings";
import { getModelMetadata } from "./index";

export const getLlamaIndexModel = async (
  model: string,
  options?: Record<string, unknown>
): Promise<unknown> => {
  const url = `${settings.runUrl}/${settings.workspace}/models/${model}`;
  const modelData = await getModelMetadata(model);
  if (!modelData) {
    throw new Error(`Model ${model} not found`);
  }
  await onLoad();
  const type = modelData?.spec?.runtime?.type || "openai";
  switch (type) {
    case "mistral":
      return mistral({
        // @ts-expect-error - We have dynamic model name, we don't want to check it here
        model: modelData?.spec?.runtime?.model,
        apiKey: settings.token,
        baseURL: `${url}/v1`,
        ...options,
      });
    case "anthropic":
      return anthropic({
        model: modelData?.spec?.runtime?.model,
        session: new AnthropicSession({
          baseURL: url,
          defaultHeaders: settings.headers,
        }),
        ...options,
      });
    default:
      return openai({
        model: modelData?.spec?.runtime?.model,
        apiKey: settings.token,
        baseURL: `${url}/v1`,
        ...options,
      });
  }
};
