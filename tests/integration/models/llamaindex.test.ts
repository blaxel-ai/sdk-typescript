import { describe, it, expect } from 'vitest'
import { blModel, blTools } from "@blaxel/llamaindex"

const testModels = [
  "sandbox-openai",
]

describe('LlamaIndex Integration', () => {
  describe('blModel', () => {
    it.each(testModels)('can chat with model %s', async (modelName) => {
      const model = await blModel(modelName)
      const result = await model.chat({
        messages: [{ role: "user", content: "Say hello in one word" }]
      })

      expect(result).toBeDefined()
      expect(result.message).toBeDefined()
      expect(result.message.content).toBeDefined()
    })
  })

  describe('blTools', () => {
    it('can load MCP tools', async () => {
      const tools = await blTools(["blaxel-search"])

      expect(tools.length).toBeGreaterThan(0)
      expect(tools[0]).toBeDefined()
    })

    it('can invoke a tool', async () => {
      const tools = await blTools(["blaxel-search"])

      expect(tools.length).toBeGreaterThan(0)

      const result = await tools[0].call({
        query: "What is the capital of France?",
      })

      expect(result).toBeDefined()
    })
  })
})

