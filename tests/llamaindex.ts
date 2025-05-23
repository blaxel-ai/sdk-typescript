import { logger } from "@blaxel/core";
import { blModel, blTools } from "@blaxel/llamaindex";
import { agent, AgentStream, tool } from "llamaindex";
import { z } from "zod";
import { prompt } from "./prompt";

async function main() {
  const tools = await blTools(["blaxel-search"]);
  const llm = await blModel("gpt-4o-mini");
  const stream = agent({
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
  }).run("Give me info about troyes");

  for await (const event of stream) {
    if (event instanceof AgentStream) {
      for (const chunk of event.data.delta) {
        process.stdout.write(chunk);
      }
    }
  }
  process.stdout.write("\n\n");
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
