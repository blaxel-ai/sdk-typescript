import { SandboxInstance } from "@blaxel/core";

// ============ CONFIGURATION ============
const RUNS_PER_IMAGE = 2; // Number of times to run each image
const AUTO_CLEANUP = false; // Set to true to automatically delete sandboxes after each test
const PARALLEL = 5; // Number of sandboxes to create/test in parallel (1 = sequential)
// Determine environment and region from BL_ENV
const blEnv = process.env.BL_ENV;
const env = blEnv === 'dev' ? 'dev' : 'prod';
const REGION = process.env.BL_REGION || (env === 'dev' ? 'eu-dub-1' : 'us-pdx-1'); // Override region with BL_REGION env var if set
// =======================================

console.log(`🔧 Environment: ${env} (BL_ENV=${blEnv || 'not set'})`);
console.log(`📍 Region: ${REGION}`);
console.log(`🔁 Runs per image: ${RUNS_PER_IMAGE}`);
console.log(`⚡ Parallel: ${PARALLEL}`);
console.log(`🧹 Auto-cleanup: ${AUTO_CLEANUP ? 'enabled' : 'disabled'}\n`);

// Images to benchmark
const images = [
  'sandbox/minimal',
  'blaxel/base-image',
  'blaxel/expo',
  'blaxel/nextjs',
  'blaxel/node',
  'blaxel/py-app',
  'blaxel/ts-app',
  'blaxel/vite',
];

interface BenchResult {
  image: string;
  sandboxName: string;
  sandboxUrl?: string;
  createTime: number;
  createSuccess: boolean;
  execTime1: number;
  exec1Success: boolean;
  execTime2: number;
  exec2Success: boolean;
  totalTime: number;
  success: boolean;
  error?: string;
}

async function benchImage(image: string, run: number): Promise<BenchResult> {
  // Use timestamp + random string to avoid collisions in parallel execution
  const randomId = Math.random().toString(36).substring(2, 8);
  const sandboxName = `bench-${image.split('/').pop()}-${Date.now()}-${randomId}`;

  console.log(`\n📦 Benchmarking: ${image} (run ${run}/${RUNS_PER_IMAGE})`);
  console.log(`   Sandbox: ${sandboxName}`);

  let createTime = 0;
  let createSuccess = false;
  let execTime1 = 0;
  let exec1Success = false;
  let execTime2 = 0;
  let exec2Success = false;
  let sandbox: SandboxInstance | null = null;
  let sandboxUrl: string | undefined;
  let overallError: string | undefined;

  // Create sandbox
  try {
    const createStart = Date.now();
    sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: image,
      region: REGION,
    });
    createTime = Date.now() - createStart;
    createSuccess = true;
    sandboxUrl = sandbox.metadata?.url;
    console.log(`   ✓ Created in ${createTime}ms`);
  } catch (error) {
    createTime = Date.now();
    let errorMsg = 'Unknown error';
    if (error instanceof Error) {
      errorMsg = error.message;
    } else if (typeof error === 'object' && error !== null) {
      errorMsg = JSON.stringify(error);
    } else {
      errorMsg = String(error);
    }
    console.log(`   ❌ Create failed: ${errorMsg}`);
    overallError = errorMsg;
  }

  // Run first process (ls / - slower) - only if sandbox was created
  if (sandbox) {
    try {
      const execStart1 = Date.now();
      await sandbox.process.exec({ command: "ls /" });
      execTime1 = Date.now() - execStart1;
      exec1Success = true;
      console.log(`   ✓ Process 1 (ls /) executed in ${execTime1}ms`);
    } catch (error) {
      execTime1 = Date.now();
      let errorMsg = 'Unknown error';
      if (error instanceof Error) {
        errorMsg = error.message;
      } else if (typeof error === 'object' && error !== null) {
        errorMsg = JSON.stringify(error);
      } else {
        errorMsg = String(error);
      }
      console.log(`   ❌ Process 1 failed: ${errorMsg}`);
      if (!overallError) overallError = errorMsg;
    }

    // Run second process (echo - faster) - regardless of first process result
    try {
      const execStart2 = Date.now();
      await sandbox.process.exec({ command: "echo 'hello'" });
      execTime2 = Date.now() - execStart2;
      exec2Success = true;
      console.log(`   ✓ Process 2 (echo) executed in ${execTime2}ms`);
    } catch (error) {
      execTime2 = Date.now();
      let errorMsg = 'Unknown error';
      if (error instanceof Error) {
        errorMsg = error.message;
      } else if (typeof error === 'object' && error !== null) {
        errorMsg = JSON.stringify(error);
      } else {
        errorMsg = String(error);
      }
      console.log(`   ❌ Process 2 failed: ${errorMsg}`);
      if (!overallError) overallError = errorMsg;
    }
  }

  const totalTime = createTime + execTime1 + execTime2;
  const success = createSuccess && exec1Success && exec2Success;

  if (success) {
    console.log(`   ✅ Total: ${totalTime}ms`);
  } else {
    console.log(`   ⚠️  Partial/Failed: ${totalTime}ms`);
  }

  // Clean up sandbox: always delete successful runs, keep failed ones if AUTO_CLEANUP is false
  const shouldCleanup = AUTO_CLEANUP || success;
  if (shouldCleanup && sandbox) {
    // Fire and forget - don't wait for deletion to complete
    SandboxInstance.delete(sandboxName)
      .then(() => console.log(`   🧹 Cleaned up ${sandboxName}`))
      .catch(() => console.log(`   ⚠ Could not delete ${sandboxName}`));
  } else if (!success && !AUTO_CLEANUP) {
    console.log(`   💾 Keeping failed sandbox for inspection: ${sandboxName}`);
  }

  return {
    image: image,
    sandboxName,
    sandboxUrl,
    createTime,
    createSuccess,
    execTime1,
    exec1Success,
    execTime2,
    exec2Success,
    totalTime,
    success,
    error: overallError,
  };
}

// Helper function to run tasks in parallel with a concurrency limit
async function runInParallel<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  const executing: Promise<void>[] = [];

  for (const task of tasks) {
    const promise = task().then(result => {
      results.push(result);
      executing.splice(executing.indexOf(promise), 1);
    });

    executing.push(promise);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

async function main() {
  console.log("========================================");
  console.log("     SANDBOX BENCHMARK SUITE");
  console.log("========================================");

  // Warmup: create PARALLEL number of sandboxes to warm the system
  console.log(`\n🔥 Warming up system with ${PARALLEL} parallel sandbox(es)...`);
  const warmupPromises: Promise<void>[] = [];
  for (let i = 0; i < PARALLEL; i++) {
    warmupPromises.push(
      (async () => {
        try {
          const randomId = Math.random().toString(36).substring(2, 8);
          const warmupName = `warmup-${Date.now()}-${randomId}`;
          const warmupSandbox = await SandboxInstance.create({
            name: warmupName,
            image: 'blaxel/base-image',
            region: REGION,
          });
          await warmupSandbox.process.exec({ command: "echo warmup" });
          // Fire and forget deletion
          SandboxInstance.delete(warmupName).catch(() => {});
          console.log(`✓ Warmup ${i + 1}/${PARALLEL} complete`);
        } catch (error) {
          console.log(`⚠ Warmup ${i + 1}/${PARALLEL} failed`);
        }
      })()
    );
  }
  await Promise.all(warmupPromises);
  console.log("✓ All warmups complete\n");

  const results: BenchResult[] = [];

  for (const image of images) {
    // Create tasks for all runs of this image
    const tasks: (() => Promise<BenchResult>)[] = [];
    for (let run = 1; run <= RUNS_PER_IMAGE; run++) {
      tasks.push(async () => {
        const result = await benchImage(image, run);
        // Small delay between tests
        await new Promise(resolve => setTimeout(resolve, 1000));
        return result;
      });
    }

    // Run tasks with specified parallelism
    const imageResults = await runInParallel<BenchResult>(tasks, PARALLEL);
    results.push(...imageResults);
  }

  // Print summary
  console.log("\n\n========================================");
  console.log("           BENCHMARK RESULTS");
  console.log("========================================\n");

  // Print detailed per-sandbox report
  console.log("DETAILED PER-SANDBOX RESULTS");
  console.log("----------------------------\n");
  console.log("Sandbox Name                              | Image              | Create    | Exec1     | Exec2     | Total");
  console.log("------------------------------------------|--------------------|-----------|-----------|-----------|---------");

  for (const result of results) {
    const name = result.sandboxName.padEnd(41);
    const img = result.image.padEnd(18);

    const createStatus = result.createSuccess ? `${result.createTime}ms` : 'FAILED';
    const create = createStatus.padEnd(9);

    const exec1Status = result.exec1Success ? `${result.execTime1}ms` : 'FAILED';
    const exec1 = exec1Status.padEnd(9);

    const exec2Status = result.exec2Success ? `${result.execTime2}ms` : 'FAILED';
    const exec2 = exec2Status.padEnd(9);

    const total = `${result.totalTime}ms`.padEnd(7);

    console.log(`${name} | ${img} | ${create} | ${exec1} | ${exec2} | ${total}`);
  }

  console.log("\n");

  // Group results by image
  const resultsByImage = new Map<string, BenchResult[]>();
  for (const result of results) {
    if (!resultsByImage.has(result.image)) {
      resultsByImage.set(result.image, []);
    }
    resultsByImage.get(result.image)!.push(result);
  }

  console.log("AGGREGATE RESULTS BY IMAGE");
  console.log("--------------------------\n");
  console.log("Image                    | Avg Create | Avg Exec1 | Avg Exec2 | Avg Total | Min Total | Max Total");
  console.log("-------------------------|------------|-----------|-----------|-----------|-----------|----------");

  for (const [image, imageResults] of resultsByImage) {
    const successful = imageResults.filter(r => r.success);

    if (successful.length > 0) {
      const avgCreate = Math.round(successful.reduce((sum, r) => sum + r.createTime, 0) / successful.length);
      const avgExec1 = Math.round(successful.reduce((sum, r) => sum + r.execTime1, 0) / successful.length);
      const avgExec2 = Math.round(successful.reduce((sum, r) => sum + r.execTime2, 0) / successful.length);
      const avgTotal = Math.round(successful.reduce((sum, r) => sum + r.totalTime, 0) / successful.length);
      const minTotal = Math.min(...successful.map(r => r.totalTime));
      const maxTotal = Math.max(...successful.map(r => r.totalTime));

      const imageName = image.padEnd(24);
      const create = `${avgCreate}ms`.padEnd(10);
      const exec1 = `${avgExec1}ms`.padEnd(9);
      const exec2 = `${avgExec2}ms`.padEnd(9);
      const total = `${avgTotal}ms`.padEnd(9);
      const minT = `${minTotal}ms`.padEnd(9);
      const maxT = `${maxTotal}ms`;
      console.log(`${imageName} | ${create} | ${exec1} | ${exec2} | ${total} | ${minT} | ${maxT}`);
    } else {
      const failedCount = imageResults.length;
      console.log(`${image.padEnd(24)} | FAILED (0/${failedCount} successful)`);
    }
  }

  // Calculate overall stats
  const successful = results.filter(r => r.success);
  if (successful.length > 0) {
    const avgCreate = Math.round(successful.reduce((sum, r) => sum + r.createTime, 0) / successful.length);
    const avgExec1 = Math.round(successful.reduce((sum, r) => sum + r.execTime1, 0) / successful.length);
    const avgExec2 = Math.round(successful.reduce((sum, r) => sum + r.execTime2, 0) / successful.length);
    const avgTotal = Math.round(successful.reduce((sum, r) => sum + r.totalTime, 0) / successful.length);
    const minTotal = Math.min(...successful.map(r => r.totalTime));
    const maxTotal = Math.max(...successful.map(r => r.totalTime));

    console.log("-------------------------|------------|-----------|-----------|-----------|-----------|----------");
    const name = "Overall Average".padEnd(24);
    const create = `${avgCreate}ms`.padEnd(10);
    const exec1 = `${avgExec1}ms`.padEnd(9);
    const exec2 = `${avgExec2}ms`.padEnd(9);
    const total = `${avgTotal}ms`.padEnd(9);
    const minT = `${minTotal}ms`.padEnd(9);
    const maxT = `${maxTotal}ms`;
    console.log(`${name} | ${create} | ${exec1} | ${exec2} | ${total} | ${minT} | ${maxT}`);
  }

  console.log("\n========================================");
  console.log(`✅ Success: ${successful.length}/${results.length}`);
  console.log(`❌ Failed: ${results.length - successful.length}/${results.length}`);

  // List failed sandboxes
  const failed = results.filter(r => !r.success);
  if (failed.length > 0) {
    console.log("\n❌ Failed Sandboxes:");
    for (const result of failed) {
      console.log(`   - ${result.sandboxName} (${result.image})`);
      if (result.sandboxUrl) {
        console.log(`     Test: curl ${result.sandboxUrl}/health -H "Authorization: Bearer $(bl token)"`);
      }
      if (result.error) {
        const errorPreview = result.error.split('\n')[0]; // First line of error
        console.log(`     Error: ${errorPreview}`);
      }
    }
  }

  console.log("========================================\n");

  if (successful.length < results.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Unexpected error:", err);
  process.exit(1);
});

