import { agent, AgentStream, tool } from "llamaindex";
import { z } from "zod";
import { blModel, blTools, logger } from "../src/index.js";
import { prompt } from "./prompt";

async function main() {
  const stream = agent({
    llm: await blModel("gpt-4o-mini").ToLlamaIndex(),
    tools: [...await blTools(['blaxel-search','webcrawl']).ToLlamaIndex(),
      tool({
        name: "weather",
        description: "Get the weather in a specific city",
        parameters: z.object({
          city: z.string(),
        }),
        execute: async (input) => {
          logger.debug("TOOLCALLING: local weather", input)
          return `The weather in ${input.city} is sunny`;
        },
      })
    ],
    systemPrompt: prompt,
  }).run(process.argv[2]);

  for await (const event of stream) {
    if (event instanceof AgentStream) {
      for (const chunk of event.data.delta) {
        process.stdout.write(chunk);
      }
    }
  }
  process.stdout.write('\n\n');
}

main()
.then(() => {
  process.exit(0)
})
.catch(err=>{
  console.error(err)
  process.exit(1)
});
