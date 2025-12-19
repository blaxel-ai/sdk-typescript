import { SandboxInstance } from "@blaxel/core";

const BL_REGION = process.env.BL_REGION || (process.env.BL_ENV === "dev" ? "eu-dub-1" : "us-pdx-1");

async function waitForDeletion(sandboxName: string, maxWaitTimeMs: number = 120000): Promise<boolean> {
  const startTime = Date.now();
  const checkIntervalMs = 2000; // 2 seconds

  while (Date.now() - startTime < maxWaitTimeMs) {
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);

    try {
      const sandboxStatus = await SandboxInstance.get(sandboxName);
      console.log(`   Status: ${sandboxStatus.status} (${elapsedSeconds}s elapsed)`);

      // If still exists but not deleted, keep waiting
      if (sandboxStatus.status === "DELETING") {
        await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
        continue;
      }

      // If exists and not deleting, something went wrong
      console.log(`   ⚠️  Sandbox exists with status: ${sandboxStatus.status}`);
      await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
    } catch (e: any) {
      // If we get a 404 or similar, the sandbox is deleted (this is expected)
      if (e.status === 404 || e.code === 404 || e.message?.includes("not found") || e.message?.includes("404") || !e.message) {
        console.log(`   ✅ Sandbox deleted (404 received after ${elapsedSeconds}s)`);
        return true;
      }
      // Other unexpected errors
      console.log(`   ⚠️  Unexpected error checking status: ${e.message || e.code || 'Unknown error'}`);
      await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
    }
  }

  console.log(`   ❌ Timeout waiting for deletion after ${Math.floor(maxWaitTimeMs / 1000)}s`);
  return false;
}

async function checkSandboxState(sandboxName: string, iteration: number): Promise<void> {
  try {
    const sandbox = await SandboxInstance.get(sandboxName);
    console.log(`\n🔍 [Iteration ${iteration}] Sandbox state check:`);
    console.log(`   Name: ${sandbox.metadata?.name}`);
    console.log(`   Status: ${sandbox.status}`);

    if (sandbox.status === "DELETING") {
      console.log(`   ⚠️⚠️⚠️  FOUND STUCK SANDBOX IN DELETING STATE! ⚠️⚠️⚠️`);
      console.log(`   This happened at iteration ${iteration}`);
      return;
    }
  } catch (e: any) {
    console.log(`\n🔍 [Iteration ${iteration}] Sandbox does not exist (expected after deletion)`);
  }
}

async function runSingleWorker(workerId: number, sandboxName: string, maxIterations: number): Promise<void> {
  try {
    for (let i = 1; i <= maxIterations; i++) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`📦 [Worker ${workerId}] [Iteration ${i}/${maxIterations}] Creating sandbox...`);

      const sandbox = await SandboxInstance.create({
        name: sandboxName,
        region: BL_REGION,
        memory: 2048 // Use smaller memory for faster creation
      });
      await sandbox.wait();
      console.log(`✅ [Worker ${workerId}] [Iteration ${i}] Sandbox created: ${sandbox.metadata?.name} (Status: ${sandbox.status})`);

      // Verify status with a fresh GET request
      const sandboxCheck = await SandboxInstance.get(sandboxName);
      console.log(`🔍 [Worker ${workerId}] [Iteration ${i}] Verified status via GET: ${sandboxCheck.status}`);

      if (sandboxCheck.status === "DELETING") {
        console.log(`   ⚠️⚠️⚠️  [Worker ${workerId}] SANDBOX IS ALREADY IN DELETING STATE AFTER CREATION! ⚠️⚠️⚠️`);
        process.exit(1);
      }

      // Small delay to ensure sandbox is fully ready
      await new Promise(resolve => setTimeout(resolve, 1000));

      console.log(`\n🗑️  [Worker ${workerId}] [Iteration ${i}] Deleting sandbox...`);
      await SandboxInstance.delete(sandboxName);
      console.log(`✅ [Worker ${workerId}] [Iteration ${i}] Delete request sent`);

      console.log(`\n⏳ [Worker ${workerId}] [Iteration ${i}] Waiting for deletion to complete...`);
      const deleted = await waitForDeletion(sandboxName);

      if (!deleted) {
        console.log(`\n❌ [Worker ${workerId}] [Iteration ${i}] Failed to confirm deletion, checking state...`);
        await checkSandboxState(sandboxName, i);
        console.log(`\n⚠️  [Worker ${workerId}] Stopping test due to timeout`);
        process.exit(1);
      }

      // Very short delay before recreating - this is where race condition might occur
      const raceWindowMs = 100;
      console.log(`\n⏱️  [Worker ${workerId}] [Iteration ${i}] Waiting ${raceWindowMs}ms before recreating (race window)...`);
      await new Promise(resolve => setTimeout(resolve, raceWindowMs));

      // Check if sandbox is in a weird state before trying to create
      await checkSandboxState(sandboxName, i);

      console.log(`\n✨ [Worker ${workerId}] [Iteration ${i}] Completed successfully`);
    }

    console.log(`\n✅ [Worker ${workerId}] All ${maxIterations} iterations completed successfully!`);
  } catch (e: any) {
    console.error(`\n❌ [Worker ${workerId}] Error occurred:`, e);
    console.error(`   Message: ${e.message}`);
    console.error(`   Status: ${e.status}`);

    if (e.status === 409 || e.message?.includes("already exists")) {
      console.error(`\n🔍 [Worker ${workerId}] Conflict detected! Checking sandbox state...`);
      try {
        const sandbox = await SandboxInstance.get(sandboxName);
        console.error(`   Current status: ${sandbox.status}`);
        if (sandbox.status === "DELETING") {
          console.error(`\n🎯 [Worker ${workerId}] RACE CONDITION FOUND!`);
          console.error(`   Sandbox is stuck in DELETING state after create attempt`);
        }
      } catch (checkError) {
        console.error(`   Could not check sandbox state:`, checkError);
      }
    }

    import('util').then(util => {
      console.error(util.inspect(e, { depth: null }));
    });
    throw e;
  }
}

async function main() {
  const sandboxBaseName = "sandbox-race-reproducer";
  const numWorkers = 10;
  const maxIterations = parseInt(process.env.MAX_ITERATIONS || "50", 10);

  console.log(`🔄 Starting PARALLEL delete-recreate race condition reproducer`);
  console.log(`   Region: ${BL_REGION}`);
  console.log(`   Base sandbox name: ${sandboxBaseName}`);
  console.log(`   Number of parallel workers: ${numWorkers}`);
  console.log(`   Iterations per worker: ${maxIterations}`);
  console.log(`   Total operations: ${numWorkers * maxIterations * 2} (create + delete)`);
  console.log(`   Strategy: Run ${numWorkers} parallel loops doing Create → Delete → Recreate\n`);

  try {
    // Create 10 parallel workers, each with their own sandbox name
    const workers = Array.from({ length: numWorkers }, (_, i) => {
      const sandboxName = `${sandboxBaseName}-${i + 1}`;
      return runSingleWorker(i + 1, sandboxName, maxIterations);
    });

    // Wait for all workers to complete
    await Promise.all(workers);

    console.log(`\n${"=".repeat(60)}`);
    console.log(`✅ All ${numWorkers} workers completed successfully!`);
    console.log(`   Total iterations: ${numWorkers * maxIterations}`);
    console.log(`   No race condition detected.`);

  } catch (e: any) {
    console.error(`\n❌ One or more workers failed`);
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error("❌ Unhandled error => ", err);
    process.exit(1);
  })
  .then(() => {
    console.log("\n✅ Test completed");
    process.exit(0);
  });

