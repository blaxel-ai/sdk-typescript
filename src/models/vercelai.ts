import { createAnthropic } from '@ai-sdk/anthropic';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import settings from "../common/settings";
import { getModelMetadata } from './index';
import { onLoad } from '../common/autoload';

export const getVercelAIModel = async (model: string, options?: any) => {
  const url = `${settings.runUrl}/${settings.workspace}/models/${model}`
  const modelData = await getModelMetadata(model)
  if(!modelData) {
    throw new Error(`Model ${model} not found`)
  }
  await onLoad()
  const type = modelData?.spec?.runtime?.type || 'openai'
  const modelId = modelData?.spec?.runtime?.model || 'gpt-4o'
  switch(type) {
    case 'mistral':
      return createMistral({
        apiKey: settings.token,
        baseURL: `${url}/v1`,
        ...options
      })(modelId);
    case 'anthropic':
      return createAnthropic({
        apiKey: settings.token,
        baseURL: `${url}`,
        ...options
      })(modelId);
    default:
      return createOpenAI({
        apiKey: settings.token,
        baseURL: `${url}/v1`,
        ...options
      })(modelId);
  }
}