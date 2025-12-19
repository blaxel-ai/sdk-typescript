import { describe, it, expect } from 'vitest'
import { blTools, getTool, settings } from "@blaxel/core"
import { blTools as langgraphTools } from "@blaxel/langgraph"
import { blTools as llamaindexTools } from "@blaxel/llamaindex"
import { blTools as mastraTools } from "@blaxel/mastra"
import { blTools as vercelTools } from "@blaxel/vercel"

describe('MCP Tools Integration', () => {
  describe('LangGraph tools', () => {
    it('can load tools from blaxel-search', async () => {
      const tools = await langgraphTools(["blaxel-search"])

      expect(tools.length).toBeGreaterThan(0)
    })

    it('can invoke a tool', async () => {
      const tools = await langgraphTools(["blaxel-search"])

      expect(tools.length).toBeGreaterThan(0)

      const result = await tools[0].invoke({
        query: "What is the capital of France?",
      })

      expect(result).toBeDefined()
    })
  })

  describe('LlamaIndex tools', () => {
    it('can load tools from blaxel-search', async () => {
      const tools = await llamaindexTools(["blaxel-search"])

      expect(tools.length).toBeGreaterThan(0)
    })

    it('can call a tool', async () => {
      const tools = await llamaindexTools(["blaxel-search"])

      expect(tools.length).toBeGreaterThan(0)

      const result = await tools[0].call({
        query: "What is the capital of France?",
      })

      expect(result).toBeDefined()
    })
  })

  describe('Vercel tools', () => {
    it('can load tools from blaxel-search', async () => {
      const tools = await vercelTools(["blaxel-search"])

      expect(tools).toBeDefined()
      expect(tools.web_search_exa).toBeDefined()
    })

    it('can execute a tool', async () => {
      const tools = await vercelTools(["blaxel-search"])

      expect(tools.web_search_exa).toBeDefined()

      // @ts-expect-error - tool execute typing
      const result = await tools.web_search_exa.execute({
        query: "What is the capital of France?",
      })

      expect(result).toBeDefined()
    })
  })

  describe('Mastra tools', () => {
    it('can load tools from blaxel-search', async () => {
      const tools = await mastraTools(["blaxel-search"])

      expect(tools).toBeDefined()
      expect(tools.web_search_exa).toBeDefined()
    })

    it('can execute a tool', async () => {
      const tools = await mastraTools(["blaxel-search"])

      expect(tools.web_search_exa).toBeDefined()

      // @ts-expect-error - tool execute typing
      const result = await tools.web_search_exa.execute({
        query: "What is the capital of France?",
      })

      expect(result).toBeDefined()
    })
  })

  describe('Core blTools', () => {
    it('can get tool names', () => {
      const tools = blTools(["blaxel-search"])

      expect(tools.toolNames).toBeDefined()
      expect(tools.toolNames.length).toBeGreaterThan(0)
    })

    it('can get and invoke tools', async () => {
      const tools = blTools(["blaxel-search"])
      const toolsBootted = await Promise.all(
        tools.toolNames.map(async (name) => {
          return await getTool(name)
        })
      )

      expect(toolsBootted.length).toBeGreaterThan(0)

      const result = await toolsBootted[0][0].call({
        query: "What is the capital of France?",
      })

      expect(result).toBeDefined()
    })
  })

  describe('Multiple MCP sources', () => {
    it('can load tools from multiple sources', async () => {
      try {
        const tools = await langgraphTools(["trello-mk2", "blaxel-search", "sandboxes/base"])

        let hasTrello = false
        let hasWebSearch = false
        let hasSandbox = false

        for (const tool of tools) {
          if (tool.name === "get_cards_by_list_id") hasTrello = true
          if (tool.name === "web_search_exa") hasWebSearch = true
          if (tool.name === "fsGetWorkingDirectory") hasSandbox = true
        }

        // At least web search should be available
        expect(hasWebSearch).toBe(true)
      } catch (error) {
        // Skip if workloads not found - this is optional
        if (error instanceof Error && error.toString().includes("Workload not found")) {
          const appUrl = settings.baseUrl.replace("api.", "app.").replace("/v0", "")
          console.info(`Skipping multi-source test: Workload not found.
Check your workspace here: ${appUrl}/${settings.workspace}/global-agentic-network/functions`)
        } else {
          throw error
        }
      }
    })
  })
})

