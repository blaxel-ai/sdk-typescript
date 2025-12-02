import { createOrGetSandbox, info, sep } from "../utils";

async function createSandbox(index: number): Promise<void> {
  const sandboxName = `parallel-test-${index}-${Date.now()}`;
  const startTime = Date.now();

  try {
    info(`🚀 [${index}] Creating sandbox: ${sandboxName}`);
    const sandbox = await createOrGetSandbox({ sandboxName, region: "us-was-1", image: "blaxel/dev-base:latest" });
    const createTime = Date.now() - startTime;
    info(`✅ [${index}] Created sandbox: ${sandboxName} (${createTime}ms)`);

    // Log sandbox details
    info(`📋 [${index}] Sandbox details:`);
    info(`   - Name: ${sandbox.metadata?.name}`);
    info(`   - Image: ${sandbox.spec?.runtime?.image}`);
    info(`   - Memory: ${sandbox.spec?.runtime?.memory}MB`);

    const totalTime = Date.now() - startTime;
    info(`🎉 [${index}] Complete: ${sandboxName} (total: ${totalTime}ms)`);

    return;
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`❌ [${index}] Failed for sandbox: ${sandboxName} (${totalTime}ms)`, error);
    throw error;
  }
}

async function main() {
  console.log(sep);
  console.log("🧪 Starting parallel sandbox mass creation test");
  console.log("📊 Creating sandboxes in batches");
  console.log(sep);

  const startTime = Date.now();

  // Configuration
  const BATCH_SIZE = 10;  // Number of sandboxes to create in parallel (N)
  const TOTAL_SANDBOXES = 1000;  // Total number of sandboxes to create
  const totalBatches = Math.ceil(TOTAL_SANDBOXES / BATCH_SIZE);

  console.log(`📋 Configuration:`);
  console.log(`   - Batch size: ${BATCH_SIZE} sandboxes in parallel`);
  console.log(`   - Total sandboxes: ${TOTAL_SANDBOXES}`);
  console.log(`   - Total batches: ${totalBatches}`);
  console.log(sep);

  let successCount = 0;
  let failCount = 0;

  try {
    // Process in batches
    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
      const batchStartTime = Date.now();
      const startIdx = batchNum * BATCH_SIZE;
      const endIdx = Math.min(startIdx + BATCH_SIZE, TOTAL_SANDBOXES);
      const batchSize = endIdx - startIdx;

      console.log(`\n🔄 Batch ${batchNum + 1}/${totalBatches}: Creating sandboxes ${startIdx + 1}-${endIdx}`);

      // Create array of promises for this batch
      const batchTasks = Array.from({ length: batchSize }, (_, index) =>
        createSandbox(startIdx + index + 1)
      );

      // Run batch in parallel
      const results = await Promise.allSettled(batchTasks);

      // Count successes and failures
      const batchSuccess = results.filter(r => r.status === 'fulfilled').length;
      const batchFail = results.filter(r => r.status === 'rejected').length;
      successCount += batchSuccess;
      failCount += batchFail;

      const batchTime = Date.now() - batchStartTime;
      console.log(`   ✅ Batch ${batchNum + 1} complete: ${batchSuccess} succeeded, ${batchFail} failed (${batchTime}ms)`);
    }

    const totalTime = Date.now() - startTime;
    console.log(sep);
    console.log(`🎉 Batch creation complete!`);
    console.log(`   - Successfully created: ${successCount}/${TOTAL_SANDBOXES} sandboxes`);
    if (failCount > 0) {
      console.log(`   - Failed: ${failCount} sandboxes`);
    }
    console.log(`⏱️ Total time: ${totalTime}ms (${(totalTime/1000).toFixed(2)}s)`);
    console.log(`📈 Average time per sandbox: ${(totalTime/successCount).toFixed(0)}ms`);
    console.log(`📊 Average time per batch: ${(totalTime/totalBatches).toFixed(0)}ms`);
    console.log(sep);
    console.log("⚠️  Note: Sandboxes were NOT deleted - they remain active");
    console.log("💡 You can delete them manually if needed");
    console.log(sep);

    if (failCount > 0) {
      console.log(`⚠️  Warning: ${failCount} sandbox creations failed`);
    }

  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.log(sep);
    console.error(`❌ Critical error after ${totalTime}ms`);
    console.error(`   Created ${successCount} sandboxes before failure`);
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
    console.log("✨ Mass create test completed");
    process.exit(0);
  });
