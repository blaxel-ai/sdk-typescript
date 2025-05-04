import { generateText } from "ai";
import { blModel, logger } from "../src/index.js";

const MODEL = "gpt-4o-mini";
// const MODEL = "claude-3-5-sonnet"
// const MODEL = "xai-grok-beta"
// const MODEL = "cohere-command-r-plus"
// const MODEL = "gemini-2-0-flash"
// const MODEL = "deepseek-chat"
// const MODEL = "mistral-large-latest"
// const MODEL = "cerebras-llama-3-3-70b"

async function langchain() {
  const model = await blModel(MODEL).ToLangChain();
  const result = await model.invoke("Hello, world!");
  logger.info(`langchain: ${result.content as string}`);
}

async function llamaindex() {
  const model = await blModel(MODEL).ToLlamaIndex();
  const result = await model.complete({ prompt: "Hello, world!" });
  logger.info(`llamaindex: ${result.text}`);
}

async function mastra() {
  const model = await blModel(MODEL).ToMastra();
  const result = await generateText({
    model,
    prompt: "Hello, world!",
  });
  logger.info(`mastra: ${result.text}`);
}

async function vercelai() {
  const model = await blModel(MODEL).ToVercelAI();
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
