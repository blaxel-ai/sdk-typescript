import { blModel as blModelVercel } from "@blaxel/vercel";
import { generateText } from "ai";

let modelName = "sandbox-openai";

async function main() {
  const model = await blModelVercel(modelName);
  const result = await generateText({
    model,
    prompt: "Hello, world!",
  });
  // @ts-ignore
  console.info(`vercelai, ${modelName}: ${result.text}`);

  await new Promise(resolve => setTimeout(resolve, 40000)); // wait 40s, token will expire

  const result2 = await generateText({
    model,
    prompt: "Hello, world!",
  });
  // @ts-ignore
  console.info(`vercelai, ${modelName}: ${result2.text}`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
