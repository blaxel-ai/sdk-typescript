import { describe, it, expect } from 'vitest'
import { blModel, blTools } from "@blaxel/langgraph"
import { HumanMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import { createReactAgent } from "@langchain/langgraph/prebuilt"
import { z } from "zod"

const prompt = `You are a helpful assistant that can answer questions and help with tasks.`

const testModels = [
  "sandbox-openai",
]

describe('LangGraph Integration', () => {
  describe('blModel', () => {
    it.each(testModels)('can invoke model %s', async (modelName) => {
      const model = await blModel(modelName)
      const result = await model.invoke("Say hello in one word")

      expect(result).toBeDefined()
      expect(result.content).toBeDefined()
      expect(typeof result.content).toBe('string')
    })
  })

  describe('Agent with tools', () => {
    it('can run agent with local and remote tools', async () => {
      const weatherTool = tool(
        (input: { city: string }): string => {
          return `The weather in ${input.city} is sunny`
        },
        {
          name: "weather",
          description: "Get the weather in a specific city",
          schema: z.object({
            city: z.string(),
          }),
        }
      )

      const model = await blModel("sandbox-openai")
      const remoteTools = await blTools(["blaxel-search"])

      expect(remoteTools.length).toBeGreaterThan(0)

      const agent = createReactAgent({
        llm: model,
        tools: [...remoteTools, weatherTool],
        prompt: prompt,
      })

      const result = await agent.invoke({
        messages: [new HumanMessage("What's the weather in Paris?")],
      })

      expect(result).toBeDefined()
      expect(result.messages).toBeDefined()
      expect(result.messages.length).toBeGreaterThan(0)
    })
  })
})

