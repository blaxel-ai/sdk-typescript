import { env, logger } from "@blaxel/core";
import { blModel, blTools, } from "@blaxel/llamaindex";
import Fastify from "fastify";
import { AgentStream, agent as llamaIndexAgent, tool } from "llamaindex";
import { z } from "zod";
import { prompt } from "./prompt.js";
import '@blaxel/telemetry';

interface RequestBody {
  inputs: string;
}

async function agent(input: string) {
  const tools = await blTools(["blaxel-search"]);
  const llm = await blModel("gpt-4o-mini");
  const stream = llamaIndexAgent({
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
          logger.debug("TOOLCALLING: local weather", input);
          return `The weather in ${input.city} is sunny`;
        },
      }),
    ],
    systemPrompt: prompt,
  }).run(input);

  let msg = '';
  for await (const event of stream) {
    if (event instanceof AgentStream) {
      for (const chunk of event.data.delta) {
        msg += chunk;
      }
    }
  }
  return msg;
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
