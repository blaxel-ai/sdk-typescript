import { SandboxInstance } from "@blaxel/core";
import { createOrGetSandbox } from "../utils";

// Test the watch functionality of SandboxFileSystem
async function testInfiniteLog(sandbox: SandboxInstance) {
  try {
    // Create a 200KB file with clear start and end markers
    console.log("Creating 200KB file...");
    await sandbox.process.exec({
      command: `echo "=== START OF 200KB FILE ===" > large_file.txt && dd if=/dev/zero bs=1024 count=200 | tr '\\0' 'A' >> large_file.txt && echo "=== END OF 200KB FILE ===" >> large_file.txt`,
      name: "create-file",
    });

    // Check file size to verify it was created correctly
    await sandbox.process.exec({
      command: "ls -lh large_file.txt",
      name: "check-file-size",
    });

    // Start a long-running process that outputs the file content with delays
    console.log("Starting file output process...");

    // Make 100 calls in parallel and print only the size
    const promises = Array.from({ length: 100 }, (_, i) =>
      sandbox.fs.read("/large_file.txt").then(fileContent => ({
        callNumber: i + 1,
        size: fileContent.length
      }))
    );

    const results = await Promise.all(promises);
    results.forEach(result => {
      console.log(`Call ${result.callNumber} - File size: ${result.size} bytes`);
    });

    console.log("testInfiniteLog passed");
  } catch (e) {
    console.error("There was an error => ", e);
  }
}

async function main() {
  const sandboxName = "sandbox-test-read-multiple-file"
  try {
    const sandbox = await createOrGetSandbox({sandboxName})
    await testInfiniteLog(sandbox)
  } catch (e) {
    console.error("There was an error => ", e);
  } finally {
    console.log("Deleting sandbox");
    await SandboxInstance.delete(sandboxName)
  }
}

main()
  .catch((err) => {
    console.error("There was an error => ", err);
    process.exit(1);
  })
  .then(() => {
    process.exit(0);
  })