import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { logger } from "@blaxel/core"
import { blModel, blTools } from "@blaxel/llamaindex"
import Fastify, { FastifyInstance } from "fastify"
import { ReActAgent, tool } from "llamaindex"
import { z } from "zod"

const prompt = `You are a helpful assistant that can answer questions and help with tasks.`

interface RequestBody {
  inputs: string
}

describe('Fastify + LlamaIndex E2E', () => {
  let app: FastifyInstance
  let baseUrl: string

  beforeAll(async () => {
    app = Fastify()

    app.post<{ Body: RequestBody }>("/", async (request, reply) => {
      try {
        const tools = await blTools(["blaxel-search"])
        const llm = await blModel("sandbox-openai")

        const reactAgent = new ReActAgent({
          llm,
          tools: [
            ...tools,
            tool({
              name: "weather",
              description: "Get the weather in a specific city",
              parameters: z.object({
                city: z.string(),
              }),
              execute: async (input) => {
                logger.debug("TOOLCALLING: local weather", input)
                return `The weather in ${input.city} is sunny`
              },
            }),
          ],
          systemPrompt: prompt,
        })

        const response = await reactAgent.chat({
          message: request.body.inputs,
        })

        return reply.status(200).send(response.message.content.toString())
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        console.error('LlamaIndex E2E error:', errorMessage)
        return reply.status(500).send(errorMessage)
      }
    })

    const port = 0 // Let OS assign a random port
    const address = await app.listen({ port, host: '127.0.0.1' })
    baseUrl = address
  })

  afterAll(async () => {
    await app.close()
  })

  it('can process agent request through Fastify', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: "What's the weather in Paris?" }),
    })

    const result = await response.text()

    if (response.status !== 200) {
      console.error('LlamaIndex E2E test failed:', result)
    }

    expect(response.status).toBe(200)
    expect(result).toBeDefined()
    expect(result.length).toBeGreaterThan(0)
  })
})
