import { blModel, blTools } from "@blaxel/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createAgent } from "langchain";
import { z } from "zod";
import { prompt } from "./prompt.js";
import { getModels } from "./utils.js";

async function runAgent(model: string) {
  try {
    console.info(`🚀 Running agent for model ${model}`);
    const weatherTool = tool(
      (input: { city: string }): string => {
        console.debug("TOOLCALLING: local weather", input);
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
    const agent = createAgent({
      model: await blModel(model),
      tools: [...(await blTools(["blaxel-search"])), weatherTool],
      systemPrompt: prompt,
    });
    const stream = await agent.stream({
      messages: [new HumanMessage("Give me the weather in Paris")],
    });
    for await (const chunk of stream) {
      continue
    }
    console.log(`✅ Successfully ran agent for model ${model}`);
  } catch (error) {
    console.error(`❌ Error running agent for model ${model}:`, error);
  }
}

const models = getModels();
await Promise.all(models.map(runAgent));
