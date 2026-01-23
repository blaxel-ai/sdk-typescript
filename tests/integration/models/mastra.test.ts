import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { blModel, blTools } from "@blaxel/mastra"
import { SandboxInstance } from "@blaxel/core"
import { generateText } from "ai"
import { uniqueName, defaultImage, defaultLabels } from '../sandbox/helpers.js'

const testModels = [
  "sandbox-openai",
]

describe('Mastra Integration', () => {
  const sandboxName = uniqueName("mastra-model-test")

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
    it('can load sandbox tools', async () => {
      const tools = await blTools([`sandbox/${sandboxName}`])

      expect(tools).toBeDefined()
      expect(Object.keys(tools).length).toBeGreaterThan(0)
    })

    it('can execute a tool', async () => {
      const tools = await blTools([`sandbox/${sandboxName}`])

      expect(Object.keys(tools).length).toBeGreaterThan(0)

      // Find the exec tool
      const execToolName = Object.keys(tools).find(name => name.toLowerCase().includes('exec'))
      if (execToolName) {
        // @ts-expect-error - tool execute typing
        const result: unknown = await tools[execToolName].execute({
          command: "echo 'Hello'",
        })

        expect(result).toBeDefined()
      }
    })
  })
})
