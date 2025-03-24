import { ChatAnthropic } from "@langchain/anthropic";
import { ChatCohere } from "@langchain/cohere";
import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatOpenAI } from "@langchain/openai";
import { CohereClient } from "cohere-ai";
import settings from "../common/settings";
import { getModelMetadata } from './index';
import { onLoad } from "../common/autoload";

export const getLangchainModel = async (model: string, options?: any) : Promise<any> => {
  const url = `${settings.runUrl}/${settings.workspace}/models/${model}`
  const modelData = await getModelMetadata(model)
  if(!modelData) {
    throw new Error(`Model ${model} not found`)
  }
  await onLoad()
  const type = modelData?.spec?.runtime?.type || 'openai'
  switch(type) {
    case 'mistral':
      return new ChatOpenAI({
        apiKey: settings.token,
        model: modelData?.spec?.runtime?.model,
        configuration: {
          baseURL: `${url}/v1`,
        },
        ...options
      });
    case 'cohere':
      return new ChatCohere({
        apiKey: settings.token,
        model: modelData?.spec?.runtime?.model,
        client: new CohereClient({
          token: settings.token,
          environment: url,
        }),
      });
    case 'deepseek':
      return new ChatDeepSeek({
        apiKey: settings.token,
        model: modelData?.spec?.runtime?.model,
        configuration: {
          baseURL: `${url}/v1`,
        },
        ...options
      });
    case 'anthropic':
      return new ChatAnthropic({
        anthropicApiUrl: url,
        model: modelData?.spec?.runtime?.model,
        clientOptions: {
          defaultHeaders: settings.headers,
        },
        ...options
      });
    default:
      return new ChatOpenAI({
        apiKey: settings.token,
        model: modelData?.spec?.runtime?.model,
        configuration: {
          baseURL: `${url}/v1`,
        },
        ...options
      });
    }
}
