import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import "@blaxel/core"
import { blModel, blTools } from "@blaxel/langgraph"
import { HumanMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import { createReactAgent } from "@langchain/langgraph/prebuilt"
import Fastify, { FastifyInstance } from "fastify"
import { z } from "zod"

const prompt = `You are a helpful assistant that can answer questions and help with tasks.`

interface RequestBody {
  inputs: string
}

describe('Fastify + LangChain E2E', () => {
  let app: FastifyInstance
  let baseUrl: string

  beforeAll(async () => {
    app = Fastify()

    app.post<{ Body: RequestBody }>("/", async (request, reply) => {
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
      const response = await createReactAgent({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        llm: model as any,
        prompt: prompt,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        tools: [...remoteTools, weatherTool] as any,
      }).invoke({
        messages: [new HumanMessage(request.body.inputs)],
      })

      return reply.status(200).send(response.messages[response.messages.length - 1].content)
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

    expect(response.status).toBe(200)

    const result = await response.text()
    expect(result).toBeDefined()
    expect(result.length).toBeGreaterThan(0)
  })
})

