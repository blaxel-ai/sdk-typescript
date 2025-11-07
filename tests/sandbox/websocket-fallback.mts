import { createOrGetSandbox } from "../utils.ts";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function testWebSocketHttpFallback() {
  console.log("=== Testing WebSocket with HTTP Fallback ===\n");

  const sandbox = await createOrGetSandbox({
    sandboxName: "websocket-fallback-test",
    connectionType: "websocket"
  });

  try {
    // Test 1: Binary write/read operations (should use HTTP)
    console.log("[TEST 1] Binary operations (HTTP fallback)");

    console.log("  - Writing large binary file (5MB)");
    const largeBinary = new Uint8Array(5 * 1024 * 1024); // 5MB
    for (let i = 0; i < largeBinary.length; i++) {
      largeBinary[i] = i % 256;
    }

    await sandbox.fs.writeBinary("/tmp/large-binary.bin", largeBinary);
    console.log("    ✓ Large binary file written");

    console.log("  - Reading large binary file");
    const readBlob = await sandbox.fs.readBinary("/tmp/large-binary.bin");
    const readBinary = new Uint8Array(await readBlob.arrayBuffer());
    console.assert(readBinary.length === largeBinary.length, "Binary size mismatch");
    console.log(`    ✓ Binary file read: ${readBinary.length} bytes`);

    // Test 2: File download (should use HTTP)
    console.log("\n[TEST 2] File download (HTTP fallback)");

    const testContent = "This is a test file for download";
    await sandbox.fs.write("/tmp/download-test.txt", testContent);

    const downloadPath = join(__dirname, "temp-download.txt");
    console.log("  - Downloading file to local filesystem");
    await sandbox.fs.download("/tmp/download-test.txt", downloadPath);

    const downloadedContent = readFileSync(downloadPath, "utf-8");
    console.assert(downloadedContent === testContent, "Downloaded content mismatch");
    console.log(`    ✓ File downloaded: ${downloadedContent.length} bytes`);

    // Cleanup
    unlinkSync(downloadPath);
    console.log("    ✓ Local file cleaned up");

    // Test 3: Log streaming (should use HTTP)
    console.log("\n[TEST 3] Log streaming (HTTP fallback)");

    const proc = await sandbox.process.exec({
      command: "for i in 1 2 3; do echo Line $i; sleep 0.1; done",
      name: "stream-test",
    });

    const streamedLogs: string[] = [];
    console.log("  - Streaming process logs");

    const stream = sandbox.process.streamLogs(proc.pid, {
      onLog: (log) => {
        streamedLogs.push(log);
      },
    });

    // Wait for process to complete
    await sandbox.process.wait(proc.pid, { maxWait: 5000 });

    // Give streaming a moment to finish
    await new Promise(resolve => setTimeout(resolve, 500));

    stream.close();
    console.log(`    ✓ Streamed ${streamedLogs.length} log line(s)`);
    console.assert(streamedLogs.length > 0, "No logs streamed");

    // Test 4: File watching (should use HTTP)
    console.log("\n[TEST 4] File watching (HTTP fallback)");

    await sandbox.fs.mkdir("/tmp/watch-test");

    const watchedEvents: any[] = [];
    console.log("  - Starting file watcher");

    const watcher = sandbox.fs.watch("/tmp/watch-test", (event) => {
      watchedEvents.push(event);
    }, { withContent: false, ignore: [] });

    // Give watcher time to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Create a file to trigger watch event
    console.log("  - Creating file to trigger watch");
    await sandbox.fs.write("/tmp/watch-test/watched-file.txt", "Watch me!");

    // Wait for watch event
    await new Promise(resolve => setTimeout(resolve, 2000));

    watcher.close();
    console.log(`    ✓ Watched ${watchedEvents.length} event(s)`);

    // Test 5: Mixed operations (WebSocket + HTTP fallback)
    console.log("\n[TEST 5] Mixed operations");

    // WebSocket operation: create directory
    console.log("  - Creating directory via WebSocket");
    await sandbox.fs.mkdir("/tmp/mixed-test");

    // WebSocket operation: write text file
    console.log("  - Writing text file via WebSocket");
    await sandbox.fs.write("/tmp/mixed-test/text.txt", "Text content");

    // HTTP fallback: write binary file
    console.log("  - Writing binary file via HTTP fallback");
    const binaryData = new Uint8Array([10, 20, 30, 40, 50]);
    await sandbox.fs.writeBinary("/tmp/mixed-test/binary.bin", binaryData);

    // WebSocket operation: list directory
    console.log("  - Listing directory via WebSocket");
    const mixedDir = await sandbox.fs.ls("/tmp/mixed-test");
    console.log(`    ✓ Found ${mixedDir.files.length} file(s)`);
    console.assert(mixedDir.files.length === 2, "Should have 2 files");

    // HTTP fallback: read binary file
    console.log("  - Reading binary file via HTTP fallback");
    const binaryBlob = await sandbox.fs.readBinary("/tmp/mixed-test/binary.bin");
    const readData = new Uint8Array(await binaryBlob.arrayBuffer());
    console.assert(readData.length === 5, "Binary read size mismatch");
    console.log(`    ✓ Binary file read: ${readData.length} bytes`);

    // Cleanup
    console.log("\n[CLEANUP] Removing test files");
    await sandbox.fs.rm("/tmp/large-binary.bin");
    await sandbox.fs.rm("/tmp/download-test.txt");
    await sandbox.fs.rm("/tmp/watch-test", true);
    await sandbox.fs.rm("/tmp/mixed-test", true);
    console.log("  ✓ Test files cleaned up");

    console.log("\n✅ All HTTP fallback tests passed!");

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
console.log("Starting WebSocket HTTP fallback test suite...\n");
testWebSocketHttpFallback()
  .then(() => {
    console.log("\n=== All fallback tests completed successfully ===");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n=== Fallback tests failed ===");
    console.error(error);
    process.exit(1);
  });

