

import { anthropic, AnthropicSession } from "@llamaindex/anthropic";
import { openai } from "@llamaindex/openai";
import settings from "../common/settings";
import { getModelMetadata } from './index';
import { onLoad } from "../common/autoload";

export const getLlamaIndexModel = async (model: string, options?: any) => {
  const url = `${settings.runUrl}/${settings.workspace}/models/${model}`
  const modelData = await getModelMetadata(model)
  if(!modelData) {
    throw new Error(`Model ${model} not found`)
  }
  await onLoad()
  const type = modelData?.spec?.runtime?.type || 'openai'
  switch(type) {
    // case 'mistral':
    //   return mistral({
    //     model: modelData?.spec?.runtime?.model,
    //     apiKey: settings.token,
    //     baseURL: `${url}/v1`,
    //     ...options
    //   });
    // case 'cohere':
    //   throw new Error("Cohere is not supported in LlamaIndex integration with blaxel")
    // case 'deepseek':
    //   return openai({
    //     model: modelData?.spec?.runtime?.model,
    //     apiKey: settings.token,
    //     baseURL: `${url}/v1`,
    //     ...options
    //   });
    case 'anthropic':
      return anthropic({
        model: modelData?.spec?.runtime?.model,
        session: new AnthropicSession({
          baseURL: url,
          defaultHeaders: settings.headers,
        }),
        ...options
      });
    default:
      return openai({
        model: modelData?.spec?.runtime?.model,
        apiKey: settings.token,
        baseURL: `${url}/v1`,
        ...options
      });
  }

}