import { blModel as blModelLangGraph } from "@blaxel/langgraph";
import { blModel as blModelLlamaIndex } from "@blaxel/llamaindex";
import { blModel as blModelMastra } from "@blaxel/mastra";
import { blModel as blModelVercel } from "@blaxel/vercel";
import { generateText } from "ai";

// Execution mode:
// - "parallel": All first calls in parallel, wait 40s, all second calls in parallel
// - "sequential": Each call followed by 40s wait (call1 -> 40s -> call2 -> 40s -> next model...)
const executionMode: "parallel" | "sequential" = "parallel";

// Models that support authentication/tokens
const models = [
  "gpt-4o-mini",
  "claude-sonnet-4",
  "cerebras-sandbox",
  "cohere-command-r-plus",
  "mistral-large-latest",
  "deepseek-chat",
  "gemini-2-5-pro-preview-06-05",
  "xai-grok-beta",
];

// Frameworks to test - comment out any you don't want to test
const frameworks = [
  "langchain",
  "llamaindex",
  "mastra",
  "vercelai",
];

interface TestCase {
  framework: string;
  modelName: string;
  model: any;
  testFunc: (model: any, modelName: string, requestNum: number) => Promise<void>;
}

async function testLangchain(model: any, modelName: string, requestNum: number) {
  const result = await model.invoke("Hello, world!");
  // @ts-ignore
  console.info(`langchain, ${modelName} (request ${requestNum}): ${result.content as string}`);
}

async function testLlamaindex(model: any, modelName: string, requestNum: number) {
  const result = await model.chat({messages: [{role: "user", content: "Hello, world!"}]});
  // @ts-ignore
  console.info(`llamaindex, ${modelName} (request ${requestNum}): ${result.message.content.toString()}`);
}

async function testMastra(model: any, modelName: string, requestNum: number) {
  const result = await generateText({
    model,
    prompt: "Hello, world!",
  });
  // @ts-ignore
  console.info(`mastra, ${modelName} (request ${requestNum}): ${result.text}`);
}

async function testVercelai(model: any, modelName: string, requestNum: number) {
  const result = await generateText({
    model,
    prompt: "Hello, world!",
  });
  // @ts-ignore
  console.info(`vercelai, ${modelName} (request ${requestNum}): ${result.text}`);
}

async function runParallel(testCases: TestCase[]) {
  console.info("\n=== Running first requests in parallel ===");

  // Run all first requests in parallel
  const firstRequests = testCases.map(async ({ framework, modelName, model, testFunc }) => {
    try {
      await testFunc(model, modelName, 1);
    } catch (err) {
      console.error(`Error in first request for ${framework}, ${modelName}:`, err);
    }
  });

  await Promise.all(firstRequests);

  console.info("\n=== Waiting 40s for tokens to expire... ===");
  await new Promise(resolve => setTimeout(resolve, 40000)); // wait 40s, token will expire

  console.info("\n=== Running second requests in parallel (after token expiry) ===");

  // Run all second requests in parallel
  const secondRequests = testCases.map(async ({ framework, modelName, model, testFunc }) => {
    try {
      await testFunc(model, modelName, 2);
    } catch (err) {
      console.error(`Error in second request for ${framework}, ${modelName}:`, err);
    }
  });

  await Promise.all(secondRequests);
}

async function runSequential(testCases: TestCase[]) {
  console.info("\n=== Running requests sequentially with 40s between each call ===");

  let callNumber = 0;
  for (let i = 0; i < testCases.length; i++) {
    const { framework, modelName, model, testFunc } = testCases[i];
    callNumber++;

    // First request
    console.info(`\n--- Call ${callNumber}: ${framework}, ${modelName} (request 1) ---`);
    try {
      await testFunc(model, modelName, 1);
    } catch (err) {
      console.error(`Error in first request for ${framework}, ${modelName}:`, err);
    }

    console.info(`Waiting 40s before next call...`);
    await new Promise(resolve => setTimeout(resolve, 40000));

    // Second request
    callNumber++;
    console.info(`\n--- Call ${callNumber}: ${framework}, ${modelName} (request 2 after token expiry) ---`);
    try {
      await testFunc(model, modelName, 2);
    } catch (err) {
      console.error(`Error in second request for ${framework}, ${modelName}:`, err);
    }

    // Wait 40s before next model (if not the last one)
    if (i < testCases.length - 1) {
      console.info(`Waiting 40s before next model...`);
      await new Promise(resolve => setTimeout(resolve, 40000));
    }
  }
}

async function main() {
  // Prepare all test cases
  const testCases: TestCase[] = [];

  for (const modelName of models) {
    try {
      if (frameworks.includes("langchain")) {
        console.info(`Loading langchain model: ${modelName}`);
        const model = await blModelLangGraph(modelName);
        testCases.push({ framework: "langchain", modelName, model, testFunc: testLangchain });
      }
      if (frameworks.includes("llamaindex")) {
        console.info(`Loading llamaindex model: ${modelName}`);
        const model = await blModelLlamaIndex(modelName);
        testCases.push({ framework: "llamaindex", modelName, model, testFunc: testLlamaindex });
      }
      if (frameworks.includes("mastra")) {
        console.info(`Loading mastra model: ${modelName}`);
        const model = await blModelMastra(modelName);
        testCases.push({ framework: "mastra", modelName, model, testFunc: testMastra });
      }
      if (frameworks.includes("vercelai")) {
        console.info(`Loading vercelai model: ${modelName}`);
        const model = await blModelVercel(modelName);
        testCases.push({ framework: "vercelai", modelName, model, testFunc: testVercelai });
      }
    } catch (err) {
      console.error(`Error loading ${modelName}:`, err);
    }
  }

  if (testCases.length === 0) {
    console.error("No test cases to run");
    return;
  }

  console.info(`\n=== Testing ${models.length} model(s) with ${frameworks.length} framework(s) ===`);
  console.info(`Models: ${models.join(", ")}`);
  console.info(`Frameworks: ${frameworks.join(", ")}`);
  console.info(`Execution mode: ${executionMode}`);

  if (executionMode === "parallel") {
    await runParallel(testCases);
  } else {
    await runSequential(testCases);
  }

  console.info("\n=== All tests completed ===");
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
