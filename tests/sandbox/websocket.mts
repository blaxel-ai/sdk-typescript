import { SandboxInstance } from "@blaxel/core";

async function testWebSocketOperations() {
  console.log("=== Starting WebSocket Tests ===\n");

  const sandbox = await SandboxInstance.create({
    connectionType: "websocket"
  });

  try {
    // Test 1: Filesystem operations
    console.log("[TEST 1] Filesystem operations");

    // Create directory
    console.log("  - Creating directory /tmp/ws-test");
    await sandbox.fs.mkdir("/tmp/ws-test");

    // Write file
    console.log("  - Writing file /tmp/ws-test/hello.txt");
    await sandbox.fs.write("/tmp/ws-test/hello.txt", "Hello WebSocket!");

    // Read file
    console.log("  - Reading file /tmp/ws-test/hello.txt");
    const content = await sandbox.fs.read("/tmp/ws-test/hello.txt");
    console.assert(content === "Hello WebSocket!", "File content mismatch");
    console.log(`    ✓ Content: "${content}"`);

    // List directory
    console.log("  - Listing directory /tmp/ws-test");
    const dir = await sandbox.fs.ls("/tmp/ws-test");
    console.log(`    ✓ Found ${dir.files.length} file(s)`);

    // Write binary file
    console.log("  - Writing binary file /tmp/ws-test/binary.bin");
    const binaryData = new Uint8Array([1, 2, 3, 4, 5]);
    await sandbox.fs.writeBinary("/tmp/ws-test/binary.bin", binaryData);

    // Read binary file
    console.log("  - Reading binary file /tmp/ws-test/binary.bin");
    const binaryBlob = await sandbox.fs.readBinary("/tmp/ws-test/binary.bin");
    const readBinary = new Uint8Array(await binaryBlob.arrayBuffer());
    console.assert(readBinary.length === 5, "Binary file size mismatch");
    console.log(`    ✓ Binary size: ${readBinary.length} bytes`);

    // Write tree
    console.log("  - Writing file tree");
    await sandbox.fs.writeTree([
      { path: "file1.txt", content: "Content 1" },
      { path: "file2.txt", content: "Content 2" },
    ], "/tmp/ws-test/tree");
    const treeDir = await sandbox.fs.ls("/tmp/ws-test/tree");
    console.log(`    ✓ Created ${treeDir.files.length} file(s) in tree`);

    // Test 2: Process operations
    console.log("\n[TEST 2] Process operations");

    // Execute command
    console.log("  - Executing command: echo 'Hello from process'");
    const proc = await sandbox.process.exec({
      command: "echo 'Hello from process'",
      waitForCompletion: true,
    });
    console.log(`    ✓ Process PID: ${proc.pid}`);
    console.log(`    ✓ Process status: ${proc.status}`);

    // Get process info
    console.log("  - Getting process info");
    const procInfo = await sandbox.process.get(proc.pid);
    console.log(`    ✓ Process name: ${procInfo.name || "unnamed"}`);

    // Get process logs
    console.log("  - Getting process logs");
    const logs = await sandbox.process.logs(proc.pid);
    console.log(`    ✓ Logs length: ${logs.length} characters`);

    // List processes
    console.log("  - Listing all processes");
    const processes = await sandbox.process.list();
    console.log(`    ✓ Total processes: ${processes?.length || 0}`);

    // Execute background process
    console.log("  - Executing background process: sleep 1");
    const bgProc = await sandbox.process.exec({
      command: "sleep 1",
      name: "test-sleep",
    });
    console.log(`    ✓ Background process PID: ${bgProc.pid}`);

    // Wait for process
    console.log("  - Waiting for background process");
    const completedProc = await sandbox.process.wait(bgProc.pid, { maxWait: 5000 });
    console.log(`    ✓ Process completed with status: ${completedProc.status}`);

    // Test 3: Filesystem cleanup operations
    console.log("\n[TEST 3] Filesystem cleanup");

    // Copy files
    console.log("  - Copying directory");
    await sandbox.fs.cp("/tmp/ws-test", "/tmp/ws-test-copy");
    const copiedDir = await sandbox.fs.ls("/tmp/ws-test-copy");
    console.log(`    ✓ Copied directory has ${copiedDir.files.length} file(s)`);

    // Remove files
    console.log("  - Removing test files");
    await sandbox.fs.rm("/tmp/ws-test", true);
    await sandbox.fs.rm("/tmp/ws-test-copy", true);
    console.log("    ✓ Test files removed");

    console.log("\n✅ All WebSocket tests passed!");

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
console.log("Starting WebSocket test suite...\n");
testWebSocketOperations()
  .then(() => {
    console.log("\n=== All tests completed successfully ===");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n=== Tests failed ===");
    console.error(error);
    process.exit(1);
  });
