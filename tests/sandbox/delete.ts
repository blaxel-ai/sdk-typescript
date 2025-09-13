import { SandboxInstance } from "@blaxel/core";
import { createOrGetSandbox, info, sep } from "../utils";

async function createAndDeleteSandbox(index: number): Promise<void> {
  const sandboxName = `parallel-test-${index}-${Date.now()}`;
  const startTime = Date.now();

  try {
    info(`🚀 [${index}] Creating sandbox: ${sandboxName}`);
    const sandbox = await createOrGetSandbox({ sandboxName });
    const createTime = Date.now() - startTime;
    info(`✅ [${index}] Created sandbox: ${sandboxName} (${createTime}ms)`);

    // Delete immediately after creation
    const deleteStartTime = Date.now();
    await SandboxInstance.delete(sandboxName);
    const deleteTime = Date.now() - deleteStartTime;
    info(`🗑️ [${index}] Deleted sandbox: ${sandboxName} (${deleteTime}ms)`);

    const totalTime = Date.now() - startTime;
    info(`🎉 [${index}] Complete: ${sandboxName} (total: ${totalTime}ms)`);

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`❌ [${index}] Failed for sandbox: ${sandboxName} (${totalTime}ms)`, error);
    throw error;
  }
}

async function main() {
  console.log(sep);
  console.log("🧪 Starting parallel sandbox creation and deletion test");
  console.log("📊 Creating 10 sandboxes in parallel and deleting them immediately");
  console.log(sep);

  const startTime = Date.now();
  const numberOfSandboxes = 10;

  // Create array of promises for parallel execution
  const tasks = Array.from({ length: numberOfSandboxes }, (_, index) =>
    createAndDeleteSandbox(index + 1)
  );

  try {
    // Run all creation/deletion tasks in parallel
    await Promise.all(tasks);

    const totalTime = Date.now() - startTime;
    console.log(sep);
    console.log(`🎉 All ${numberOfSandboxes} sandboxes created and deleted successfully!`);
    console.log(`⏱️ Total time: ${totalTime}ms (${(totalTime/1000).toFixed(2)}s)`);
    console.log(`📈 Average time per sandbox: ${(totalTime/numberOfSandboxes).toFixed(0)}ms`);
    console.log(sep);

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.log(sep);
    console.error(`❌ Some operations failed after ${totalTime}ms`);
    console.log(sep);
    throw error;
  }
}

main()
  .catch((err) => {
    console.error("❌ There was an error => ", err);
    process.exit(1);
  })
  .then(() => {
    console.log("✨ Parallel delete test completed");
    process.exit(0);
  });
