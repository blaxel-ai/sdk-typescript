import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { blModel, blTools } from "@blaxel/llamaindex"
import { SandboxInstance } from "@blaxel/core"
import { uniqueName, defaultImage, defaultLabels } from '../sandbox/helpers.js'

const testModels = [
  "sandbox-openai",
]

describe('LlamaIndex Integration', () => {
  const sandboxName = uniqueName("llamaindex-model-test")

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
    it('can load sandbox tools', async () => {
      const tools = await blTools([`sandbox/${sandboxName}`])

      expect(tools.length).toBeGreaterThan(0)
      expect(tools[0]).toBeDefined()
    })

    it('can invoke a tool', async () => {
      const tools = await blTools([`sandbox/${sandboxName}`])

      expect(tools.length).toBeGreaterThan(0)

      // Find the exec tool
      const execTool = tools.find(t => t.metadata.name.toLowerCase().includes('exec'))
      if (execTool) {
        const result = await execTool.call({
          command: "echo 'Hello'",
        })

        expect(result).toBeDefined()
      }
    })
  })
})
