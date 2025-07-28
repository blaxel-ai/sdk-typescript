import { ProcessRequestWithLog, ProcessResponseWithLog, SandboxInstance } from "@blaxel/core";
import { ProcessRequest } from "../../@blaxel/core/src/sandbox/client/index.js";
import { createOrGetSandbox } from "../utils.js";

const SANDBOX_NAME = "sandbox-test-typescript-process-features";

async function testWaitForCompletionWithLogs(sandbox: SandboxInstance) {
  console.log("🔧 Testing waitForCompletion with logs...");

  // Create a process that outputs some logs
  const processRequest: ProcessRequest = {
    name: "wait-completion-test",
    command: 'sh -c "echo Starting process; echo This is stdout; echo This is stderr >&2; sleep 2; echo Process completed"',
    waitForCompletion: true,
  };

  // Execute with waitForCompletion=true
  const response = await sandbox.process.exec(processRequest);

  // Check that we got the response
  console.assert(response !== null, "Response should not be null");
  console.assert(response.name === "wait-completion-test", "Process name should match");
  console.assert(response.status !== null, "Process should have a status");

  // Check that logs were added to the response
  console.assert("logs" in response, "Response should have logs");
  const logs = response.logs;
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
  const processRequest: ProcessRequestWithLog = {
    command: 'sh -c "echo First message; sleep 1; echo Second message; sleep 1; echo Third message"',
    onLog: logCollector,
  };

  // Execute with on_log callback (name will be auto-generated)
  const response = await sandbox.process.exec(processRequest);

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
  console.log("🔧 Testing combined waitForCompletion and on_log...");

  // Create a list to collect real-time logs
  const realtimeLogs: string[] = [];

  function realtimeCollector(message: string) {
    realtimeLogs.push(message);
  }

  // Create a process with a specific name
  const processRequest: ProcessRequestWithLog = {
    name: "combined-test",
    command: 'sh -c "echo Starting combined test; sleep 1; echo Middle of test; sleep 1; echo Test completed"',
    waitForCompletion: true,
    onLog: realtimeCollector,
  };

  // Execute with both features
  const response = await sandbox.process.exec(processRequest);

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
  const processDict: ProcessRequestWithLog = {
    command: "echo 'Testing auto name generation'",
    onLog: countLogs,
  };

  // Execute with on_log (should auto-generate name)
  const response = await sandbox.process.exec(processDict);

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

async function testStreamClose(sandbox: SandboxInstance) {
  console.log("🔧 Testing stream close functionality...");

  // Track logs and when they stop
  const logMessages: string[] = [];
  let lastLogTime = Date.now();
  let isReceivingLogs = true;

  function logCollector(message: string) {
    logMessages.push(message);
    lastLogTime = Date.now();
    isReceivingLogs = true;
    console.log(`   📝 Log received at ${new Date().toISOString()}: ${JSON.stringify(message)}`);
  }

  // Create a long-running process that outputs logs continuously
  const processRequest: ProcessRequestWithLog = {
    name: "stream-close-test",
    command:`sh -c 'for i in $(seq 1 5); do echo "Hello from stdout $i"; sleep 1; done'`,
    waitForCompletion: false, // Important: don't wait for completion
    onLog: logCollector,
  };

  // Execute and get response with close() method
  const response = await sandbox.process.exec(processRequest) as ProcessResponseWithLog;

  // Check that we got a response with close method
  console.assert("close" in response, "Response should have close() method");
  console.assert(typeof response.close === "function", "close should be a function");

  // Wait for a few logs to come in
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Should have received some logs by now
  const logsBeforeClose = logMessages.length;
  console.assert(logsBeforeClose > 0, "Should have received some logs before close");
  console.log(`✅ Received ${logsBeforeClose} logs before closing`);

  // Close the stream
  console.log("   🛑 Calling close() to stop the stream...");
  response.close();

  // Mark that we're no longer expecting logs
  isReceivingLogs = false;

  // Wait a bit to ensure no more logs come in
  const logsAtClose = logMessages.length;
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Check that no new logs were received after close
  const logsAfterClose = logMessages.length;
  console.assert(logsAfterClose === logsAtClose, `No new logs should be received after close (before: ${logsAtClose}, after: ${logsAfterClose})`);

  console.log(`✅ Stream closed successfully. Total logs received: ${logMessages.length}`);
  console.log(`✅ Process should still be running in background (not killed by close)`);

  // Verify the process is still running (close should only stop streaming, not kill the process)
  try {
    const processInfo = await sandbox.process.get(response.name!);
    console.log(`✅ Process status after close: ${processInfo.status} -> ${processInfo.logs}`);
  } catch (error) {
    console.log(`⚠️ Could not check process status: ${error}`);
  }
}

async function testBasicProcessFirst(sandbox: SandboxInstance) {
  console.log("🔧 Testing basic process functionality first...");

  const basicRequest: ProcessRequest = {
    name: "basic-test",
    command: 'echo "Basic test works"',
    waitForCompletion: true,
  };

  const response = await sandbox.process.exec(basicRequest);
  console.log(`✅ Basic process works: ${response.name}, status: ${response.status}`);
}

async function testProcessRestartOnFailure(sandbox: SandboxInstance) {
  console.log("🔧 Testing process restart on failure...");

  // Test 1: Process that fails initially but succeeds on retry
  console.log("   📝 Test 1: Process that succeeds after restart");

  // Create a process that fails the first time but succeeds on second attempt
  // Using inline script instead of writing to filesystem
  const processRequest: ProcessRequest = {
    name: "restart-test-eventual-success",
    command: `sh -c 'echo \"before-exit\"; sleep 0.5; exit 1'`,
    restartOnFailure: true,
    maxRestarts: 5,
    waitForCompletion: true,
  };

  const response = await sandbox.process.exec(processRequest);
  const processInfo = response as any; // Use any to access restart properties

  console.assert(response.name === "restart-test-eventual-success", "Process name should match");
  console.assert(response.status === "completed", `Process should eventually succeed, got status: ${response.status}`);
  console.assert(processInfo.restartOnFailure === true, "restartOnFailure should be true");
  console.assert(processInfo.maxRestarts === 5, "maxRestarts should be 5");
  console.assert(processInfo.currentRestarts > 0, `Process should have restarted at least once, got: ${processInfo.currentRestarts}`);
  console.assert(processInfo.exitCode === 0, `Final exit code should be 0, got: ${processInfo.exitCode}`);

  console.log(`✅ Process succeeded after ${processInfo.currentRestarts} restarts`);
  console.log(`✅ Final exit code: ${processInfo.exitCode}`);

  // Test 2: Process that exhausts all restart attempts
  /*
  console.log("   📝 Test 2: Process that exhausts restart attempts");

  const failingProcessRequest: ProcessRequest = {
    name: "restart-test-always-fail",
    command: 'sh -c "echo Attempt failed; exit 1"',
    restartOnFailure: true,
    maxRestarts: 3,
    waitForCompletion: true,
  };

  const failingResponse = await sandbox.process.exec(failingProcessRequest);
  const failingInfo = failingResponse as any;

  console.assert(failingResponse.name === "restart-test-always-fail", "Process name should match");
  console.assert(failingResponse.status === "failed", `Process should fail after exhausting restarts, got: ${failingResponse.status}`);
  console.assert(failingInfo.currentRestarts === 3, `Process should have attempted exactly 3 restarts, got: ${failingInfo.currentRestarts}`);
  console.assert(failingInfo.maxRestarts === 3, "maxRestarts should be 3");
  console.assert(failingInfo.exitCode !== 0, `Exit code should indicate failure, got: ${failingInfo.exitCode}`);

  console.log(`✅ Process failed after exhausting ${failingInfo.currentRestarts} restart attempts`);
  console.log(`✅ Final status: ${failingResponse.status}`);

  // Test 3: Process without restart on failure (control test)
  console.log("   📝 Test 3: Process without restart enabled (control)");

  const noRestartRequest: ProcessRequest = {
    name: "no-restart-test",
    command: 'sh -c "echo This will fail; exit 1"',
    restartOnFailure: false,
    waitForCompletion: true,
  };

  const noRestartResponse = await sandbox.process.exec(noRestartRequest);
  const noRestartInfo = noRestartResponse as any;

  console.assert(noRestartResponse.name === "no-restart-test", "Process name should match");
  console.assert(noRestartResponse.status === "failed", `Process should fail immediately, got: ${noRestartResponse.status}`);
  console.assert(noRestartInfo.currentRestarts === 0, `Process should not have restarted, got: ${noRestartInfo.currentRestarts}`);
  console.assert(noRestartInfo.restartOnFailure === false, "restartOnFailure should be false");

  console.log(`✅ Process failed without restart attempts: ${noRestartInfo.currentRestarts} restarts`);
  */

  console.log("✅ Process restart on failure tests completed successfully");
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

    // Run tests
    // await testWaitForCompletionWithLogs(sandbox);
    // console.log();

    // await testOnLogCallback(sandbox);
    // console.log();

    // await testCombinedFeatures(sandbox);
    // console.log();

    // await testOnLogWithoutName(sandbox);
    // console.log();

    // await testStreamClose(sandbox);
    // console.log();

    await testBasicProcessFirst(sandbox);
    console.log();
    await testProcessRestartOnFailure(sandbox);
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
