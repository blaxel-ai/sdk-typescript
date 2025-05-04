import { logger } from "@blaxel/core";
import { blModel, blTools } from "@blaxel/vercel";
import { streamText, tool } from "ai";
import { z } from "zod";
import { prompt } from "./prompt";
async function main() {
  const stream = streamText({
    model: await blModel("gpt-4o-mini"),
    messages: [{ role: "user", content: process.argv[2] }],
    system: prompt,
    tools: {
      ...(await blTools(["blaxel-search"])),
      weather: tool({
        description: "Get the weather in a specific city",
        parameters: z.object({
          city: z.string(),
        }),
        execute: async (input) => {
          logger.debug("TOOLCALLING: local weather", input);
          return Promise.resolve(`The weather in ${input.city} is sunny`);
        },
      }),
    },
    maxSteps: 5,
  });

  for await (const delta of stream.textStream) {
    process.stdout.write(delta);
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
