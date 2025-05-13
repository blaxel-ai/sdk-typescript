import { SandboxInstance } from "@blaxel/core";
import { createOrGetSandbox } from "../utils";

// Test the watch functionality of SandboxFileSystem
async function testWatch(sandbox: SandboxInstance) {
  try {
    const user = process.env.USER;
    const testDir = `/Users/${user}/Downloads/watchtest`;
    const testFile = `/file.txt`;

    // Ensure correct type for fs
    const fs = sandbox.fs;

    // Clean up before test
    try { await fs.rm(testDir, true); } catch {}
    await fs.mkdir(testDir);

    // Watch without content
    const events: string[] = []
    const contents: string[] = []
    const handle = fs.watch("/", (fileEvent) => {
      events.push(fileEvent.op)
      if (fileEvent.op === "WRITE") {
        contents.push(fileEvent.content ?? "")
      }
    }, {
      withContent: true
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.write(testFile, "content");

    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.write(testFile, "new content");

    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.rm(testFile)
    await new Promise((resolve) => setTimeout(resolve, 100));

    handle.close();

    // Clean up after test
    await fs.rm(testDir, true);


    if (!events.includes("CREATE") || !events.includes("WRITE") || !events.includes("REMOVE")) {
      throw new Error("Watch callback not consistent with expected events: " + events.join(", "));
    }
    if (!contents.includes("content") || !contents.includes("new content")) {
      throw new Error("Watch callback not consistent with expected contents: " + contents.join(", "));
    }
    console.log("testWatch passed");
  } catch (e) {
    console.error("There was an error => ", e);
  }
}

async function main() {
  const sandboxName = "sandbox-test-watch-folder"
  try {
    const sandbox = await createOrGetSandbox(sandboxName)
    await testWatch(sandbox)
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