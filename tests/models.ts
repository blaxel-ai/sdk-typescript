import { logger } from "@blaxel/core";
import { blModel as blModelLangGraph } from "@blaxel/langgraph";
import { blModel as blModelLlamaIndex } from "@blaxel/llamaindex";
import { blModel as blModelMastra } from "@blaxel/mastra";
import { blModel as blModelVercel } from "@blaxel/vercel";
import { generateText } from "ai";

const MODEL = "gpt-4o-mini";
// const MODEL = "claude-3-5-sonnet"
// const MODEL = "xai-grok-beta"
// const MODEL = "cohere-command-r-plus"
// const MODEL = "gemini-2-0-flash"
// const MODEL = "deepseek-chat"
// const MODEL = "mistral-large-latest"
// const MODEL = "cerebras-llama-3-3-70b"

async function langchain() {
  const model = await blModelLangGraph(MODEL);
  const result = await model.invoke("Hello, world!");
  // @ts-ignore
  logger.info(`langchain: ${result.content as string}`);
}

async function llamaindex() {
  const model = await blModelLlamaIndex(MODEL);
  const result = await model.complete({ prompt: "Hello, world!" });
  logger.info(`llamaindex: ${result.text}`);
}

async function mastra() {
  const model = await blModelMastra(MODEL);
  const result = await generateText({
    model,
    prompt: "Hello, world!",
  });
  logger.info(`mastra: ${result.text}`);
}

async function vercelai() {
  const model = await blModelVercel(MODEL);
  const result = await generateText({
    model,
    prompt: "Hello, world!",
  });
  logger.info(`vercelai: ${result.text}`);
}

async function main() {
  await langchain();
  await llamaindex();
  await mastra();
  await vercelai();
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
