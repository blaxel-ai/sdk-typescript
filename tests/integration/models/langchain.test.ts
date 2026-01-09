import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { blModel, blTools } from "@blaxel/langgraph"
import { SandboxInstance } from "@blaxel/core"
import { HumanMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import { createReactAgent } from "@langchain/langgraph/prebuilt"
import { z } from "zod"
import { uniqueName, defaultImage, defaultLabels } from '../sandbox/helpers.js'

const prompt = `You are a helpful assistant that can execute commands in a sandbox environment.`

const testModels = [
  "sandbox-openai",
]

describe('LangGraph Integration', () => {
  const sandboxName = uniqueName("langchain-model-test")

  beforeAll(async () => {
    await SandboxInstance.create({
      name: sandboxName,
      image: defaultImage,
      memory: 2048,
      labels: defaultLabels,
    })
  })

  afterAll(async () => {
    try {
      await SandboxInstance.delete(sandboxName)
    } catch {
      // Ignore
    }
  })

  describe('blModel', () => {
    it.each(testModels)('can invoke model %s', async (modelName) => {
      const model = await blModel(modelName)
      const result = await model.invoke("Say hello in one word") as { content: string }

      expect(result).toBeDefined()
      expect(result.content).toBeDefined()
      expect(typeof result.content).toBe('string')
    })
  })

  describe('Agent with tools', () => {
    it('can run agent with local and sandbox tools', async () => {
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
      const remoteTools = await blTools([`sandbox/${sandboxName}`])

      expect(remoteTools.length).toBeGreaterThan(0)

      const agent = createReactAgent({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        llm: model as any,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        tools: [...remoteTools, weatherTool] as any,
        prompt: prompt,
      })

      const result = await agent.invoke({
        messages: [new HumanMessage("Execute the command: echo 'Hello from sandbox'")],
      })

      expect(result).toBeDefined()
      expect(result.messages).toBeDefined()
      expect(result.messages.length).toBeGreaterThan(0)
    })
  })
})
