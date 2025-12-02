import { blJob } from "@blaxel/core";

async function testJobExecutions() {
  const jobName = "mk3";
  const job = blJob(jobName);

  console.log(`Testing job executions for: ${jobName}`);

  // Create a new execution
  console.log("\n1. Creating new execution...");
  const executionId = await job.createExecution({
    tasks: [
      { duration: 60 },
      { duration: 60 },
    ],
  });
  console.log(`✓ Created execution: ${executionId}`);

  // Get the execution details
  console.log("\n2. Getting execution details...");
  const execution = await job.getExecution(executionId);
  console.log(`✓ Execution status: ${execution.status}`);
  console.log(`✓ Execution metadata:`, execution.metadata);

  // Get just the status
  console.log("\n3. Getting execution status...");
  let status = await job.getExecutionStatus(executionId);
  console.log(`✓ Status: ${status}`);

  // List all executions
  console.log("\n4. Listing all executions...");
  const executions = await job.listExecutions();
  console.log(`✓ Found ${executions.length} execution(s)`);

  // Wait for completion
  console.log("\n5. Waiting for execution to complete...");
  try {
    const completedExecution = await job.waitForExecution(executionId, {
      maxWait: 360000, // 6 minutes (job runs for 5 minutes)
      interval: 3000, // 3 seconds
    });
    console.log(`✓ Execution completed with status: ${completedExecution.status}`);
  } catch (error) {
    console.log(`⚠ Execution still running or timed out: ${(error as Error).message}`);
  }

  // Get just the status
  console.log("\n6. Getting execution status...");
  status = await job.getExecutionStatus(executionId);
  console.log(`✓ Status: ${status}`);

  console.log("\n✅ All tests completed!");
}

testJobExecutions().catch((error) => {
  console.error("❌ Test failed:", error);
  process.exit(1);
});

