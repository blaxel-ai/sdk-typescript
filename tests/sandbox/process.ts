import { SandboxInstance } from "@blaxel/core";
import { ProcessRequest } from "../../@blaxel/core/src/sandbox/client/index.js";
import { createOrGetSandbox } from "../utils.js";

const SANDBOX_NAME = "sandbox-test-typescript-process-features";

async function testWaitForCompletionWithLogs(sandbox: SandboxInstance) {
  console.log("🔧 Testing wait_for_completion with logs...");

  // Create a process that outputs some logs
  const processRequest: ProcessRequest = {
    name: "wait-completion-test",
    command: 'sh -c "echo Starting process; echo This is stdout; echo This is stderr >&2; sleep 2; echo Process completed"',
    waitForCompletion: true,
  };

  // Execute with wait_for_completion=true
  const response = await sandbox.process.exec(processRequest);

  // Check that we got the response
  console.assert(response !== null, "Response should not be null");
  console.assert(response.name === "wait-completion-test", "Process name should match");
  console.assert(response.status !== null, "Process should have a status");

  // Check that logs were added to the response
  console.assert("logs" in response, "Response should have logs");
  const logs = (response as any).logs;
  console.assert(typeof logs === "string", "Logs should be a string");
  console.assert(logs.length > 0, "Logs should not be empty");

  // Verify log content
  console.assert(logs.includes("Starting process"), "Logs should contain 'Starting process'");
  console.assert(logs.includes("This is stdout"), "Logs should contain 'This is stdout'");
  console.assert(logs.includes("This is stderr"), "Logs should contain 'This is stderr'");
  console.assert(logs.includes("Process completed"), "Logs should contain 'Process completed'");

  console.log(`✅ Process completed with status: ${response.status}`);
  console.log(`✅ Retrieved logs (length: ${logs.length} chars)`);
  console.log(`   First 100 chars: ${logs.substring(0, 100)}...`);
}

async function testOnLogCallback(sandbox: SandboxInstance) {
  console.log("🔧 Testing on_log callback...");

  // Create a list to collect log messages
  const logMessages: string[] = [];

  function logCollector(message: string) {
    logMessages.push(message);
    console.log(`   📝 Log received: ${JSON.stringify(message)}`); // Show exact content
  }

  // Create a process that outputs logs over time
  const processRequest: ProcessRequest = {
    command: 'sh -c "echo First message; sleep 1; echo Second message; sleep 1; echo Third message"'
  };

  // Execute with on_log callback (name will be auto-generated)
  const response = await sandbox.process.exec(processRequest, logCollector);

  // Check that a name was generated
  console.assert(response.name !== null, "Process name should be generated");
  console.assert(response.name!.startsWith("proc-"), "Process name should start with 'proc-'");
  console.log(`✅ Auto-generated process name: ${response.name}`);

  // Wait for the process to complete and logs to be collected
  await sandbox.process.wait(response.name!);

  // Give a bit more time for final logs to arrive
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Check that we received log messages
  console.assert(logMessages.length > 0, "Should have received log messages");
  console.log(`✅ Received ${logMessages.length} log messages`);

  // Join all messages to check content
  const allLogs = logMessages.join(" ");

  // Verify we got expected messages
  console.assert(allLogs.includes("First message"), "Should contain 'First message'");
  console.assert(allLogs.includes("Second message"), "Should contain 'Second message'");
  console.assert(allLogs.includes("Third message"), "Should contain 'Third message'");

  console.log("✅ Log callback test completed successfully");
}

async function testCombinedFeatures(sandbox: SandboxInstance) {
  console.log("🔧 Testing combined wait_for_completion and on_log...");

  // Create a list to collect real-time logs
  const realtimeLogs: string[] = [];

  function realtimeCollector(message: string) {
    realtimeLogs.push(message);
  }

  // Create a process with a specific name
  const processRequest: ProcessRequest = {
    name: "combined-test",
    command: 'sh -c "echo Starting combined test; sleep 1; echo Middle of test; sleep 1; echo Test completed"',
    waitForCompletion: true,
  };

  // Execute with both features
  const response = await sandbox.process.exec(processRequest, realtimeCollector);

  // Check the response
  console.assert(response.name === "combined-test", "Process name should match");
  console.assert(response.status !== null, "Process should have a status");

  // Check that we got logs in the response
  console.assert("logs" in response, "Response should have logs");
  const finalLogs = (response as any).logs;

  // Check that we got real-time logs
  console.assert(realtimeLogs.length > 0, "Should have real-time logs");

  console.log(`✅ Process completed with status: ${response.status}`);
  console.log(`✅ Real-time logs collected: ${realtimeLogs.length} messages`);
  console.log(`✅ Final logs in response: ${finalLogs.length} chars`);

  // Verify content
  console.assert(finalLogs.includes("Starting combined test"), "Final logs should contain 'Starting combined test'");
  console.assert(finalLogs.includes("Test completed"), "Final logs should contain 'Test completed'");

  // Real-time logs should also contain the messages
  const allRealtime = realtimeLogs.join(" ");
  console.assert(allRealtime.includes("Starting combined test"), "Real-time logs should contain 'Starting combined test'");
  console.assert(allRealtime.includes("Middle of test"), "Real-time logs should contain 'Middle of test'");
  console.assert(allRealtime.includes("Test completed"), "Real-time logs should contain 'Test completed'");
}

async function testOnLogWithoutName(sandbox: SandboxInstance) {
  console.log("🔧 Testing on_log with auto-generated name...");

  let logCount = 0;

  function countLogs(message: string) {
    logCount++;
  }

  // Process without name
  const processDict: ProcessRequest = {
    command: "echo 'Testing auto name generation'"
  };

  // Execute with on_log (should auto-generate name)
  const response = await sandbox.process.exec(processDict, countLogs);

  // Check that name was generated
  console.assert(response.name !== null, "Name should be generated");
  console.assert(response.name!.startsWith("proc-"), "Name should start with 'proc-'");
  console.assert(response.name!.length > "proc-".length, "Name should have UUID suffix");

  console.log(`✅ Auto-generated name: ${response.name}`);

  // Wait a bit for logs
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Should have received at least one log
  console.assert(logCount > 0, "Should have received at least one log");
  console.log(`✅ Received ${logCount} log messages`);
}

async function main() {
  console.log("🚀 Starting sandbox process feature tests...");

  try {
    // Create or get sandbox using the utils function with proper parameters
    const sandbox = await createOrGetSandbox({
      sandboxName: SANDBOX_NAME,
      image: "blaxel/prod-base:latest"
    });
    console.log(`✅ Sandbox ready: ${sandbox.metadata?.name}`);

    await sandbox.fs.ls("/blaxel");

    // Run tests
    await testWaitForCompletionWithLogs(sandbox);
    console.log();

    await testOnLogCallback(sandbox);
    console.log();

    await testCombinedFeatures(sandbox);
    console.log();

    await testOnLogWithoutName(sandbox);
    console.log();

    console.log("🎉 All process feature tests completed successfully!");

  } catch (error) {
    console.error(`❌ Process feature test failed with error: ${error}`);
    throw error;
  } finally {
    console.log("🧹 Cleaning up...");
    try {
      await SandboxInstance.delete(SANDBOX_NAME);
      console.log("✅ Sandbox deleted");
    } catch (error) {
      console.log(`⚠️ Failed to delete sandbox: ${error}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { main };
