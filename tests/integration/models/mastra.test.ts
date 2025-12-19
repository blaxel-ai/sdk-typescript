import { describe, it, expect } from 'vitest'
import { blModel, blTools } from "@blaxel/mastra"
import { generateText } from "ai"

const testModels = [
  "sandbox-openai",
]

describe('Mastra Integration', () => {
  describe('blModel', () => {
    it.each(testModels)('can generate text with model %s', async (modelName) => {
      const model = await blModel(modelName)
      const result = await generateText({
        model,
        prompt: "Say hello in one word",
      })

      expect(result).toBeDefined()
      expect(result.text).toBeDefined()
      expect(typeof result.text).toBe('string')
    })
  })

  describe('blTools', () => {
    it('can load MCP tools', async () => {
      const tools = await blTools(["blaxel-search"])

      expect(tools).toBeDefined()
      expect(tools.web_search_exa).toBeDefined()
    })

    it('can execute a tool', async () => {
      const tools = await blTools(["blaxel-search"])

      expect(tools.web_search_exa).toBeDefined()

      // @ts-expect-error - tool execute typing
      const result: unknown = await tools.web_search_exa.execute({
        query: "What is the capital of France?",
      })

      expect(result).toBeDefined()
    })
  })
})

