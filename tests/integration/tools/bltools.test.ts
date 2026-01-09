import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { blTools, getTool, SandboxInstance } from "@blaxel/core"
import { blTools as langgraphTools } from "@blaxel/langgraph"
import { blTools as llamaindexTools } from "@blaxel/llamaindex"
import { blTools as mastraTools } from "@blaxel/mastra"
import { blTools as vercelTools } from "@blaxel/vercel"
import { uniqueName, defaultImage, defaultLabels } from '../sandbox/helpers.js'

describe('MCP Tools Integration', () => {
  describe('LangGraph tools', () => {
    const sandboxName = uniqueName("langgraph-tools-test")

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

    it('can load tools from sandbox', async () => {
      const tools = await langgraphTools([`sandbox/${sandboxName}`])

      expect(tools.length).toBeGreaterThan(0)
    })

    it('can invoke a tool', async () => {
      const tools = await langgraphTools([`sandbox/${sandboxName}`])

      expect(tools.length).toBeGreaterThan(0)

      // Find the exec tool to test
      const execTool = tools.find(t => t.name.toLowerCase().includes('exec'))
      if (execTool) {
        const result = await execTool.invoke({
          command: "echo 'hello'",
        })

        expect(result).toBeDefined()
      }
    })
  })

  describe('LlamaIndex tools', () => {
    const sandboxName = uniqueName("llamaindex-tools-test")

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

    it('can load tools from sandbox', async () => {
      const tools = await llamaindexTools([`sandbox/${sandboxName}`])

      expect(tools.length).toBeGreaterThan(0)
    })

    it('can call a tool', async () => {
      const tools = await llamaindexTools([`sandbox/${sandboxName}`])

      expect(tools.length).toBeGreaterThan(0)

      // Find the exec tool to test
      const execTool = tools.find(t => t.metadata.name.toLowerCase().includes('exec'))
      if (execTool) {
        const result = await execTool.call({
          command: "echo 'hello'",
        })

        expect(result).toBeDefined()
      }
    })
  })

  describe('Vercel tools', () => {
    const sandboxName = uniqueName("vercel-tools-test")

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

    it('can load tools from sandbox', async () => {
      const tools = await vercelTools([`sandbox/${sandboxName}`])

      expect(tools).toBeDefined()
      expect(Object.keys(tools).length).toBeGreaterThan(0)
    })

    it('can execute a tool', async () => {
      const tools = await vercelTools([`sandbox/${sandboxName}`])

      expect(Object.keys(tools).length).toBeGreaterThan(0)

      // Find the exec tool to test
      const execToolName = Object.keys(tools).find(name => name.toLowerCase().includes('exec'))
      if (execToolName) {
        // @ts-expect-error - tool execute typing
        const result: unknown = await tools[execToolName].execute({
          command: "echo 'hello'",
        })

        expect(result).toBeDefined()
      }
    })
  })

  describe('Mastra tools', () => {
    const sandboxName = uniqueName("mastra-tools-test")

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

    it('can load tools from sandbox', async () => {
      const tools = await mastraTools([`sandbox/${sandboxName}`])

      expect(tools).toBeDefined()
      expect(Object.keys(tools).length).toBeGreaterThan(0)
    })

    it('can execute a tool', async () => {
      const tools = await mastraTools([`sandbox/${sandboxName}`])

      expect(Object.keys(tools).length).toBeGreaterThan(0)

      // Find the exec tool to test
      const execToolName = Object.keys(tools).find(name => name.toLowerCase().includes('exec'))
      if (execToolName) {
        // @ts-expect-error - tool execute typing
        const result: unknown = await tools[execToolName].execute({
          command: "echo 'hello'",
        })

        expect(result).toBeDefined()
      }
    })
  })

  describe('Core blTools', () => {
    const sandboxName = uniqueName("core-tools-test")

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

    it('can get tool names', () => {
      const tools = blTools([`sandbox/${sandboxName}`])

      expect(tools.toolNames).toBeDefined()
      expect(tools.toolNames.length).toBeGreaterThan(0)
    })

    it('can get and invoke tools', async () => {
      const tools = blTools([`sandbox/${sandboxName}`])
      const toolsBootted = await Promise.all(
        tools.toolNames.map(async (name) => {
          return await getTool(name)
        })
      )

      expect(toolsBootted.length).toBeGreaterThan(0)

      // Find the exec tool to test
      const execToolEntry = toolsBootted.find(entry => entry[0]?.name.toLowerCase().includes('exec'))
      if (execToolEntry && execToolEntry[0]) {
        const result = await execToolEntry[0].call({
          command: "echo 'hello'",
        })

        expect(result).toBeDefined()
      }
    })
  })
})
