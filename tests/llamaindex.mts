import { logger } from "@blaxel/core";
import { blModel, blTools } from "@blaxel/llamaindex";
import { ReActAgent, tool } from "llamaindex";
import { z } from "zod";
import { prompt } from "./prompt";
import { getModels } from "./utils";

async function runModel(model: string) {
  try {
    console.info(`🚀 Running model ${model}`);
    const llm = await blModel(model);
    const reactAgent = new ReActAgent({
      llm,
      tools: [
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
    });

    const response = await reactAgent.chat({
      message: "what is the weather in paris",
    });
    console.log(`✅ Successfully ran agent for model ${model}`);
  } catch (error) {
    console.error(`❌ Error running agent for model ${model}:`, error);
  }
}

await Promise.all(getModels().map(runModel));
