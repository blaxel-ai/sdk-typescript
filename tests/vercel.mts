import { logger } from "@blaxel/core";
import { blModel, blTools } from "@blaxel/vercel";
import { streamText, tool } from "ai";
import { z } from "zod";
import { prompt } from "./prompt.js";
import { getModels } from "./utils.js";

async function runAgent(model: string) {
  try {
    console.info(`🚀 Running agent for model ${model}`);
    const weatherTool = tool({
      description: "Get the weather in a specific city",
      inputSchema: z.object({
        city: z.string(),
      }),
      execute: async (input) => {
        logger.debug("TOOLCALLING: local weather", input);
        return `The weather in ${input.city} is sunny`;
      },
    });
    const stream = streamText({
      model: await blModel(model),
      messages: [{ role: "user", content: "Give me info about troyes" }],
      system: prompt,
      tools: {
        weather: weatherTool,
      },
    });

    for await (const delta of stream.textStream) {
      process.stdout.write(delta);
    }
    process.stdout.write("\n\n");
    console.log(`✅ Successfully ran agent for model ${model}`);
  } catch (error) {
    console.error(`❌ Error running agent for model ${model}:`, error);
  }
}

const models = getModels();
await Promise.all(models.map(runAgent));
