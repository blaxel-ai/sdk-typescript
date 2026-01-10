import { describe, it, expect } from 'vitest'
import { blModel as blModelLangGraph } from "@blaxel/langgraph"
import { blModel as blModelLlamaIndex } from "@blaxel/llamaindex"
import { blModel as blModelMastra } from "@blaxel/mastra"
import { blModel as blModelVercel } from "@blaxel/vercel"
import { generateText } from "ai"

/**
 * This test suite verifies that all model frameworks work with the same set of models.
 * It tests basic functionality across langchain, llamaindex, mastra, and vercel integrations.
 */

// Note: Add more models as needed for comprehensive testing
// These are the models available in the workspace
const models = [
  "sandbox-openai",
]

describe('All Frameworks - Model Compatibility', () => {
  describe.each(models)('Model: %s', (modelName) => {
    it('works with LangGraph', async () => {
      const model = await blModelLangGraph(modelName)
      const result = await model.invoke("Hello, world!") as { content: string }

      expect(result).toBeDefined()
      expect(result.content).toBeDefined()
    })

    it('works with LlamaIndex', async () => {
      const model = await blModelLlamaIndex(modelName, {temperature: 1})
      const result = await model.chat({
        messages: [{ role: "user", content: "Hello, world!" }]
      })

      expect(result).toBeDefined()
      expect(result.message).toBeDefined()
      expect(result.message.content).toBeDefined()
    })

    it('works with Mastra', async () => {
      const model = await blModelMastra(modelName)
      const result = await generateText({
        model,
        prompt: "Hello, world!",
      })

      expect(result).toBeDefined()
      expect(result.text).toBeDefined()
    })

    it('works with Vercel AI', async () => {
      const model = await blModelVercel(modelName)
      const result = await generateText({
        model,
        prompt: "Hello, world!",
      })

      expect(result).toBeDefined()
      expect(result.text).toBeDefined()
    })
  })
})

