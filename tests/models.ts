import { blModel as blModelLangGraph } from "@blaxel/langgraph";
import { blModel as blModelLlamaIndex } from "@blaxel/llamaindex";
import { blModel as blModelMastra } from "@blaxel/mastra";
import { blModel as blModelVercel } from "@blaxel/vercel";
import { generateText } from "ai";

const models = [
  "gpt-4o-mini",
  "claude-3-7-sonnet-20250219",
  "cerebras-sandbox",
  "cohere-command-r-plus",
  "ministral-3b-2410",
  "gemini-2-5-pro-preview-06-05",
  "deepseek-chat",
  "xai-grok-beta",
]


async function langchain(modelName: string) {
  const model = await blModelLangGraph(modelName);
  const result = await model.invoke("Hello, world!");
  // @ts-ignore
  console.info(`langchain, ${modelName}: ${result.content as string}`);
}

async function llamaindex(modelName: string) {
  const model = await blModelLlamaIndex(modelName);
  const result = await model.chat({messages: [{role: "user", content: "Hello, world!"}]})
  // @ts-ignore
  console.info(`llamaindex, ${modelName}: ${result.message.content.toString()}`);
}

async function mastra(modelName: string) {
  const model = await blModelMastra(modelName);
  const result = await generateText({
    model,
    prompt: "Hello, world!",
  });
  // @ts-ignore
  console.info(`mastra, ${modelName}: ${result.text}`);
}

async function vercelai(modelName: string) {
  const model = await blModelVercel(modelName);
  const result = await generateText({
    model,
    prompt: "Hello, world!",
  });
  // @ts-ignore
  console.info(`vercelai, ${modelName}: ${result.text}`);
}

async function main() {
  for (const model of models) {
    await langchain(model);
    await llamaindex(model);
    await mastra(model);
    await vercelai(model);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
