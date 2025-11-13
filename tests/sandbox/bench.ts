import { SandboxInstance } from "@blaxel/core";

// ============ CONFIGURATION ============
// Determine environment and region from BL_ENV
const blEnv = process.env.BL_ENV;
const env = blEnv === 'dev' ? 'dev' : 'prod';
const REGION = process.env.BL_REGION || (env === 'dev' ? 'eu-dub-1' : 'us-pdx-1'); // Override region with BL_REGION env var if set
// =======================================

console.log(`🔧 Environment: ${env} (BL_ENV=${blEnv || 'not set'})`);
console.log(`📍 Region: ${REGION}\n`);

// Images to benchmark
const images = [
  'base-image',
  'expo',
  'nextjs',
  'node',
  'py-app',
  'ts-app',
  'vite',
];

interface BenchResult {
  image: string;
  sandboxName: string;
  createTime: number;
  execTime: number;
  totalTime: number;
  success: boolean;
  error?: string;
}

async function benchImage(image: string): Promise<BenchResult> {
  const fullImageName = `blaxel/${image}:latest`;
  const sandboxName = `bench-${image}-${Date.now()}`;

  console.log(`\n📦 Benchmarking: ${fullImageName}`);
  console.log(`   Sandbox: ${sandboxName}`);

  let createTime = 0;
  let execTime = 0;

  try {
    // Create sandbox
    const createStart = Date.now();
    const sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: fullImageName,
      region: REGION,
    });
    createTime = Date.now() - createStart;
    console.log(`   ✓ Created in ${createTime}ms`);

    // Run process (ls /)
    const execStart = Date.now();
    await sandbox.process.exec({ command: "ls /" });
    execTime = Date.now() - execStart;
    console.log(`   ✓ Executed in ${execTime}ms`);

    const totalTime = createTime + execTime;
    console.log(`   ✅ Total: ${totalTime}ms`);

    return {
      image: fullImageName,
      sandboxName,
      createTime,
      execTime,
      totalTime,
      success: true,
    };

  } catch (error) {
    let errorMsg = 'Unknown error';
    if (error instanceof Error) {
      errorMsg = `${error.message}\n${error.stack}`;
    } else if (typeof error === 'object' && error !== null) {
      errorMsg = JSON.stringify(error, null, 2);
    } else {
      errorMsg = String(error);
    }
    console.log(`   ❌ Failed: ${errorMsg}`);

    return {
      image: fullImageName,
      sandboxName,
      createTime,
      execTime,
      totalTime: createTime + execTime,
      success: false,
      error: errorMsg,
    };
  }
}

async function main() {
  console.log("========================================");
  console.log("     SANDBOX BENCHMARK SUITE");
  console.log("========================================");

  const results: BenchResult[] = [];

  for (const image of images) {
    const result = await benchImage(image);
    results.push(result);

    // Small delay between tests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Print summary
  console.log("\n\n========================================");
  console.log("           BENCHMARK RESULTS");
  console.log("========================================\n");

  console.log("Image                    | Create    | Exec   | Total");
  console.log("-------------------------|-----------|--------|----------");

  for (const result of results) {
    if (result.success) {
      const imageName = result.image.padEnd(24);
      const create = `${result.createTime}ms`.padEnd(9);
      const exec = `${result.execTime}ms`.padEnd(6);
      const total = `${result.totalTime}ms`;
      console.log(`${imageName} | ${create} | ${exec} | ${total}`);
    } else {
      console.log(`${result.image.padEnd(24)} | FAILED: ${result.error}`);
    }
  }

  // Calculate stats
  const successful = results.filter(r => r.success);
  if (successful.length > 0) {
    const avgCreate = Math.round(successful.reduce((sum, r) => sum + r.createTime, 0) / successful.length);
    const avgExec = Math.round(successful.reduce((sum, r) => sum + r.execTime, 0) / successful.length);
    const avgTotal = Math.round(successful.reduce((sum, r) => sum + r.totalTime, 0) / successful.length);

    console.log("-------------------------|-----------|--------|----------");
    console.log(`${"Average".padEnd(24)} | ${`${avgCreate}ms`.padEnd(9)} | ${`${avgExec}ms`.padEnd(6)} | ${avgTotal}ms`);
  }

  console.log("\n========================================");
  console.log(`✅ Success: ${successful.length}/${results.length}`);
  console.log(`❌ Failed: ${results.length - successful.length}/${results.length}`);
  console.log("========================================\n");

  // Cleanup all sandboxes
  console.log("🧹 Cleaning up sandboxes...");
  for (const result of results) {
    try {
      await SandboxInstance.delete(result.sandboxName);
      console.log(`   ✓ Deleted ${result.sandboxName}`);
    } catch (error) {
      console.log(`   ⚠ Could not delete ${result.sandboxName}`);
    }
  }
  console.log("✅ Cleanup complete\n");

  if (successful.length < results.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Unexpected error:", err);
  process.exit(1);
});

