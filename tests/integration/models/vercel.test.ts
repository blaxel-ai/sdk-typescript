import { describe, it, expect } from 'vitest'
import { blModel, blTools } from "@blaxel/vercel"
import { generateText, streamText, tool } from "ai"
import { z } from "zod"

const prompt = `You are a helpful assistant that can answer questions and help with tasks.`

const testModels = [
  "sandbox-openai",
]

describe('Vercel AI Integration', () => {
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

  describe('streaming', () => {
    it('can stream text', async () => {
      const model = await blModel("sandbox-openai")
      const stream = streamText({
        model,
        prompt: "Say hello in one word",
      })

      let fullText = ""
      for await (const delta of stream.textStream) {
        fullText += delta
      }

      expect(fullText.length).toBeGreaterThan(0)
    })
  })

  describe('with tools', () => {
    it('can use remote MCP tools', async () => {
      const model = await blModel("sandbox-openai")
      const tools = await blTools(["blaxel-search"])

      expect(tools).toBeDefined()

      const result = await generateText({
        model,
        prompt: "Search for information about Paris",
        system: prompt,
        tools,
        maxSteps: 3,
      })

      expect(result).toBeDefined()
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
      const result = await tools.web_search_exa.execute({
        query: "What is the capital of France?",
      })

      expect(result).toBeDefined()
    })
  })
})

