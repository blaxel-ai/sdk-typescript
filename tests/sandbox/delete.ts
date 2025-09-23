import { SandboxInstance } from "@blaxel/core";
import { createOrGetSandbox, info, sep } from "../utils";

async function createSandbox(index: number): Promise<string> {
  const sandboxName = `parallel-test-${index}-${Date.now()}`;
  const startTime = Date.now();

  try {
    info(`🚀 [${index}] Creating sandbox: ${sandboxName}`);
    await createOrGetSandbox({ sandboxName });
    const createTime = Date.now() - startTime;
    info(`✅ [${index}] Created sandbox: ${sandboxName} (${createTime}ms)`);
    return sandboxName;
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`❌ [${index}] Failed to create sandbox: ${sandboxName} (${totalTime}ms)`, error);
    throw error;
  }
}

async function deleteSandbox(sandboxName: string): Promise<void> {
  const startTime = Date.now();

  try {
    info(`🗑️ Deleting sandbox: ${sandboxName}`);
    await SandboxInstance.delete(sandboxName);
    const deleteTime = Date.now() - startTime;
    info(`✅ Deleted sandbox: ${sandboxName} (${deleteTime}ms)`);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`❌ Failed to delete sandbox: ${sandboxName} (${totalTime}ms)`, error);
    // Don't throw - we want to continue with other deletions
  }
}

async function main() {
  // Get max sandboxes from command line arg or use default
  const maxSandboxes = parseInt(process.argv[2]) || 1990;
  const batchSize = 10;

  console.log(sep);
  console.log("🧪 Starting batch sandbox creation and parallel deletion test");
  console.log(`📊 Creating ${maxSandboxes} sandboxes in batches of ${batchSize}, then deleting all in parallel`);
  console.log(sep);

  const startTime = Date.now();
  const createdSandboxes: string[] = [];

  try {
    // Phase 1: Create sandboxes in batches
    console.log("🏗️ Phase 1: Creating sandboxes in batches...");

    for (let batchStart = 0; batchStart < maxSandboxes; batchStart += batchSize) {
      const batchEnd = Math.min(batchStart + batchSize, maxSandboxes);
      const currentBatchSize = batchEnd - batchStart;

      info(`Creating batch ${Math.floor(batchStart/batchSize) + 1}: sandboxes ${batchStart + 1}-${batchEnd}`);

      // Create batch of sandboxes in parallel
      const batchTasks = Array.from({ length: currentBatchSize }, (_, index) =>
        createSandbox(batchStart + index + 1)
      );

      const batchStartTime = Date.now();
      const batchResults = await Promise.all(batchTasks);
      const batchTime = Date.now() - batchStartTime;

      createdSandboxes.push(...batchResults);
      info(`✅ Batch completed: ${currentBatchSize} sandboxes created (${batchTime}ms)`);
    }

    const createTime = Date.now() - startTime;
    console.log(sep);
    console.log(`✅ Phase 1 complete: ${createdSandboxes.length} sandboxes created (${createTime}ms)`);
    console.log(sep);

    // Phase 2: Delete ALL sandboxes in parallel
    console.log("🗑️ Phase 2: Deleting ALL sandboxes in parallel...");
    console.log(`⚡ Starting ${createdSandboxes.length} parallel deletions (aggressive mode)`);

    const deleteStartTime = Date.now();
    const deleteTasks = createdSandboxes.map(sandboxName => deleteSandbox(sandboxName));

    // Run ALL deletions in parallel without any batching
    await Promise.all(deleteTasks);

    const deleteTime = Date.now() - deleteStartTime;
    const totalTime = Date.now() - startTime;

    console.log(sep);
    console.log(`🎉 All ${createdSandboxes.length} sandboxes created and deleted successfully!`);
    console.log(`⏱️ Creation time: ${createTime}ms (${(createTime/1000).toFixed(2)}s)`);
    console.log(`⏱️ Deletion time: ${deleteTime}ms (${(deleteTime/1000).toFixed(2)}s)`);
    console.log(`⏱️ Total time: ${totalTime}ms (${(totalTime/1000).toFixed(2)}s)`);
    console.log(`📈 Average time per sandbox: ${(totalTime/createdSandboxes.length).toFixed(0)}ms`);
    console.log(sep);

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.log(sep);
    console.error(`❌ Some operations failed after ${totalTime}ms`);
    console.error(`📊 Created ${createdSandboxes.length} sandboxes before failure`);
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
    console.log("✨ Batch creation and parallel deletion test completed");
    process.exit(0);
  });
