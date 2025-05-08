import { blModel, blTools } from "@blaxel/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { prompt } from "./prompt.js";

async function main() {
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
  const response = await createReactAgent({
    llm: await blModel("gpt-4o-mini"),
    prompt: prompt,
    tools: [...(await blTools(["blaxel-search"])), weatherTool],
  }).invoke({
    messages: [new HumanMessage("Give me info about troyes")],
  });
  console.log(response.messages[response.messages.length - 1].content);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
