import { env, logger } from "@blaxel/core";
import { blModel, blTools } from "@blaxel/langgraph";
import "@blaxel/telemetry";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import Fastify from "fastify";
import { z } from "zod";
import { prompt } from "./prompt.js";

interface RequestBody {
  inputs: string;
}

async function agent(input: string) {
  const weatherTool = tool(
    (input: { city: string }): string => {
      logger.debug("TOOLCALLING: local weather", input);
      return `The weather in ${input.city} is sunny`;
    },
    {
      name: "weather",
      description: "Get the weather in a specific city",
      schema: z.object({
        city: z.string(),
      }),
    }
  );
  const response = await createReactAgent({
    llm: await blModel("gpt-4o-mini"),
    prompt: prompt,
    tools: [...(await blTools(["blaxel-search"])), weatherTool],
  }).invoke({
    messages: [new HumanMessage(input)],
  });
  return response.messages[response.messages.length - 1].content;
}

async function main() {
  logger.info("Booting up...");
  const app = Fastify();

  app.addHook("onRequest", async (request, reply) => {
    logger.info(`${request.method} ${request.url}`);
  });

  app.post<{ Body: RequestBody }>("/", async (request, reply) => {
    try {
      const result = await agent(request.body.inputs);
      return reply.status(200).send(result);
    } catch (error: any) {
      logger.error(error);
      return reply.status(500).send(error.stack);
    }
  });
  const port = parseInt(env.BL_SERVER_PORT || "1338");
  const host = env.BL_SERVER_HOST || "0.0.0.0";
  try {
    await app.listen({ port, host });
    logger.info(`Server is running on port ${host}:${port}`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

main().catch(console.error);
