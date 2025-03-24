import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { blModel, blTools, logger } from "../src/index.js";
import { prompt } from "./prompt";

async function main() {
  const stream = await createReactAgent({
    llm: await blModel("gpt-4o-mini").ToLangChain(),
    prompt: prompt,
    tools: [
      ...await blTools(['blaxel-search','webcrawl']).ToLangChain(),
      tool(async (input: any) => {
        logger.debug("TOOLCALLING: local weather", input)
        return `The weather in ${input.city} is sunny`;
      },{
        name: "weather",
        description: "Get the weather in a specific city",
        schema: z.object({
          city: z.string(),
        })
      })
    ],
  }).stream({
    messages: [new HumanMessage(process.argv[2])],
  });
  for await (const chunk of stream) {
    if(chunk.agent) for(const message of chunk.agent.messages) {
      process.stdout.write(message.content)
    }
  }
  process.stdout.write('\n\n')
}

main()
.then(() => {
  process.exit(0)
})
.catch(err=>{
  console.error(err)
  process.exit(1)
});
