import { CodeExecutionAgent } from "./agent.js";

/**
 * Test suite for the Code Execution Agent
 *
 * This test demonstrates the agent generating and executing code
 * in a Blaxel sandbox, following the code execution pattern from:
 * https://www.anthropic.com/engineering/code-execution-with-mcp
 */

const SANDBOX_NAME = "code-execution-agent-test";

async function testBasicCodeExecution() {
  console.log("\n=== Test 1: Basic Code Execution ===");

  const agent = new CodeExecutionAgent(SANDBOX_NAME);

  const result = await agent.run(
    "Generate and execute code that calculates the factorial of 10 and prints the result."
  );

  console.log("Agent response:", result);
}

async function testFileOperations() {
  console.log("\n=== Test 2: File Operations ===");

  const agent = new CodeExecutionAgent(SANDBOX_NAME);

  const result = await agent.run(
    `Generate and execute code that:
1. Creates a file called "test-data.json" with an array of 5 objects, each with a name and age
2. Reads the file back
3. Filters the data to find people older than 25
4. Writes the filtered results to "filtered-data.json"
5. Prints a summary of what was done`
  );

  console.log("Agent response:", result);

  // Verify files were created
  const sandbox = await agent.getSandbox();
  try {
    const testData = await sandbox.fs.read("/tmp/test-data.json");
    const filteredData = await sandbox.fs.read("/tmp/filtered-data.json");
    console.log("test-data.json:", testData?.substring(0, 200));
    console.log("filtered-data.json:", filteredData?.substring(0, 200));
  } catch (error) {
    console.log("Files not found in /tmp, checking root...");
  }
}

async function testDataProcessing() {
  console.log("\n=== Test 3: Data Processing ===");

  const agent = new CodeExecutionAgent(SANDBOX_NAME);

  const result = await agent.run(
    `Generate and execute code that:
1. Creates an array of 20 random numbers between 1 and 100
2. Calculates statistics: mean, median, min, max, and standard deviation
3. Groups the numbers into ranges: 1-20, 21-40, 41-60, 61-80, 81-100
4. Prints a formatted report with all statistics and the distribution`
  );

  console.log("Agent response:", result);
}

async function testAsyncOperations() {
  console.log("\n=== Test 4: Async Operations ===");

  const agent = new CodeExecutionAgent(SANDBOX_NAME);

  const result = await agent.run(
    `Generate and execute code that simulates fetching data from multiple sources:
1. Create 3 async functions that simulate API calls (each takes 100-300ms)
2. Use Promise.all to fetch from all 3 sources concurrently
3. Combine the results and print the total time taken
4. Show how concurrent execution is faster than sequential`
  );

  console.log("Agent response:", result);
}

async function testErrorHandling() {
  console.log("\n=== Test 5: Error Handling ===");

  const agent = new CodeExecutionAgent(SANDBOX_NAME);

  const result = await agent.run(
    `Generate and execute code that demonstrates error handling:
1. Try to read a non-existent file
2. Catch the error and handle it gracefully
3. Create the file if it doesn't exist
4. Retry the operation and show success`
  );

  console.log("Agent response:", result);
}

async function testStreamingResponse() {
  console.log("\n=== Test 6: Streaming Response ===");

  const agent = new CodeExecutionAgent(SANDBOX_NAME);

  let streamedContent = "";

  await agent.run(
    "Generate and execute code that prints numbers from 1 to 10 with a 100ms delay between each, explaining what's happening.",
    {
      write: (data: string) => {
        streamedContent += data;
        process.stdout.write(data);
      },
      end: () => {
        console.log("\n[Stream ended]");
      },
    }
  );

  console.log("\nTotal streamed content length:", streamedContent.length);
}

async function main() {
  console.log("🚀 Starting Code Execution Agent Tests");
  console.log("=====================================\n");

  try {
    // Run tests
    // await testBasicCodeExecution();
    // await testFileOperations();
    // await testDataProcessing();
    // await testAsyncOperations();
    // await testErrorHandling();
    // await testStreamingResponse();
    await testS3DallETelegram();

    console.log("\n✅ All tests completed successfully!");

  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

// Run tests when this file is executed
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

async function testS3DallETelegram() {
  console.log("\n=== Test 8: S3 + Dall-E + Telegram (Real API Example) ===");

  const agent = new CodeExecutionAgent(SANDBOX_NAME);

  // This demonstrates a real workflow: list S3 files, generate images, send via Telegram
  const result = await agent.run(
    `List all .txt files from S3 bucket 'super-agent-document' with prefix 'texts/'.
For each file:
1. Read the file content from S3
2. Generate an image using DALL-E with a prompt based on the file content
3. Send a Telegram message to chat '@my_channel' with the file name and content preview
4. Send the generated image via Telegram with a caption

Process all files in a loop and handle errors gracefully.`
  );

  console.log("Agent response:", result);

  // Verify tools are available
  const sandbox = await agent.getSandbox();
  try {
    const toolsListing = await sandbox.fs.ls("/tools");
    console.log("Tools directory structure:", {
      directories: toolsListing.subdirectories?.map((d: any) => d.name) || [],
      files: toolsListing.files?.map((f: any) => f.name) || [],
    });

    // Check S3 tools
    const s3Listing = await sandbox.fs.ls("/tools/s3");
    console.log("S3 tools:", s3Listing.files?.map((f: any) => f.name) || []);

    // Check DALL-E tools
    const dalleListing = await sandbox.fs.ls("/tools/dall-e");
    console.log("DALL-E tools:", dalleListing.files?.map((f: any) => f.name) || []);

    // Check Telegram tools
    const telegramListing = await sandbox.fs.ls("/tools/telegram");
    console.log("Telegram tools:", telegramListing.files?.map((f: any) => f.name) || []);
  } catch (error) {
    console.log("Error checking tools:", error);
  }
}

export { testBasicCodeExecution, testFileOperations, testDataProcessing, testS3DallETelegram };

