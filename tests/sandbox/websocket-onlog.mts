import { createOrGetSandbox } from "../utils.ts";

async function testWebSocketOnLog() {
  console.log("=== Testing WebSocket onLog Feature ===\n");

  const sandbox = await createOrGetSandbox({
    sandboxName: "websocket-onlog-test",
    connectionType: "websocket"
  });

  try {
    // Test 1: exec with onLog and waitForCompletion
    console.log("[TEST 1] exec() with onLog and waitForCompletion");

    const logs1: string[] = [];
    console.log("  - Executing: for i in 1 2 3; do echo Line $i; sleep 0.1; done");

    const proc1 = await sandbox.process.exec({
      command: "for i in 1 2 3; do echo \"Line $i\"; sleep 0.1; done",
      waitForCompletion: true,
      onLog: (log) => {
        console.log(`    [LOG] ${log}`);
        logs1.push(log);
      },
    });

    console.log(`    ✓ Process completed with status: ${proc1.status}`);
    console.log(`    ✓ Captured ${logs1.length} log line(s)`);
    console.assert(logs1.length >= 3, "Should have at least 3 log lines");
    console.assert(logs1.some(l => l.includes("Line 1")), "Should contain 'Line 1'");
    console.assert(logs1.some(l => l.includes("Line 2")), "Should contain 'Line 2'");
    console.assert(logs1.some(l => l.includes("Line 3")), "Should contain 'Line 3'");

    // Test 2: exec with onLog without waitForCompletion (background process)
    console.log("\n[TEST 2] exec() with onLog without waitForCompletion");

    const logs2: string[] = [];
    console.log("  - Starting background process with log streaming");

    const proc2 = await sandbox.process.exec({
      command: "for i in A B C D; do echo Letter $i; sleep 0.2; done",
      name: "bg-stream-test",
      onLog: (log) => {
        console.log(`    [BG LOG] ${log}`);
        logs2.push(log);
      },
    });

    console.log(`    ✓ Background process started: PID ${proc2.pid}`);

    // Wait for process to complete
    await sandbox.process.wait(proc2.pid, { maxWait: 5000 });

    // Give streaming a moment to finish
    await new Promise(resolve => setTimeout(resolve, 500));

    // Close the log stream
    if ('close' in proc2 && typeof proc2.close === 'function') {
      proc2.close();
    }

    console.log(`    ✓ Captured ${logs2.length} log line(s) in background`);
    console.assert(logs2.length >= 4, "Should have at least 4 log lines");

    // Test 3: streamLogs() direct method
    console.log("\n[TEST 3] streamLogs() direct method");

    const logs3: string[] = [];

    // Start a long-running process
    const proc3 = await sandbox.process.exec({
      command: "for i in 1 2 3 4 5; do echo Number $i; sleep 0.1; done",
      name: "stream-direct-test",
    });

    console.log("  - Starting log stream for process");
    const stream = sandbox.process.streamLogs(proc3.pid, {
      onLog: (log) => {
        console.log(`    [STREAM] ${log}`);
        logs3.push(log);
      },
    });

    // Wait for process to complete
    await sandbox.process.wait(proc3.pid, { maxWait: 5000 });

    // Give streaming a moment to finish
    await new Promise(resolve => setTimeout(resolve, 500));

    stream.close();
    console.log(`    ✓ Captured ${logs3.length} log line(s) via streamLogs()`);
    console.assert(logs3.length >= 5, "Should have at least 5 log lines");

    // Test 4: stdout/stderr separation
    console.log("\n[TEST 4] stdout/stderr separation");

    const stdoutLogs: string[] = [];
    const stderrLogs: string[] = [];

    const proc4 = await sandbox.process.exec({
      command: "echo 'stdout message' && echo 'stderr message' >&2",
      name: "stderr-test",
    });

    const stream4 = sandbox.process.streamLogs(proc4.pid, {
      onStdout: (log) => {
        console.log(`    [STDOUT] ${log}`);
        stdoutLogs.push(log);
      },
      onStderr: (log) => {
        console.log(`    [STDERR] ${log}`);
        stderrLogs.push(log);
      },
    });

    await sandbox.process.wait(proc4.pid, { maxWait: 5000 });
    await new Promise(resolve => setTimeout(resolve, 500));

    stream4.close();
    console.log(`    ✓ Stdout: ${stdoutLogs.length} line(s), Stderr: ${stderrLogs.length} line(s)`);

    console.log("\n✅ All onLog tests passed!");

  } catch (error) {
    console.error("\n❌ Test failed:", error);
    throw error;
  } finally {
    console.log("\n[CLEANUP] Closing WebSocket connection");
    await sandbox.closeConnection();
    console.log("✓ Connection closed");
  }
}

// Run tests
console.log("Starting WebSocket onLog test suite...\n");
testWebSocketOnLog()
  .then(() => {
    console.log("\n=== All onLog tests completed successfully ===");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n=== onLog tests failed ===");
    console.error(error);
    process.exit(1);
  });

