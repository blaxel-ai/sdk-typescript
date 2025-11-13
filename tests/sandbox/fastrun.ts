import { SandboxInstance } from "@blaxel/core";

// Get loop count from command line argument (default: 1)
const loopCount = parseInt(process.argv[2] || "1", 10);

async function runSingleTest(iteration: number): Promise<{
  success: boolean;
  createTime: number;
  execTime: number;
  error?: string;
  sandboxName: string;
}> {
  const sandboxName = `fastrun-test-${Date.now()}-${iteration}`;

  try {
    // Create sandbox and time it
    const createStart = Date.now();
    const sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: "blaxel/base-image",
    });
    const createTime = Date.now() - createStart;

    // Run ls process and time it
    const execStart = Date.now();
    try {
      await sandbox.process.exec({ command: "ls" });
      const execTime = Date.now() - execStart;

      // Delete sandbox
      await SandboxInstance.delete(sandboxName);

      return {
        success: true,
        createTime,
        execTime,
        sandboxName,
      };
    } catch (execError) {
      const execTime = Date.now() - execStart;

      // Try to cleanup
      try {
        await SandboxInstance.delete(sandboxName);
      } catch {
        // Ignore cleanup errors
      }

      let errorMsg = "Unknown error";
      if (execError instanceof Error) {
        errorMsg = execError.message;

        if ('response' in execError && execError.response) {
          const response = execError.response as Response;
          errorMsg = `${response.status} ${response.statusText} - ${execError.message}`;
        }
      }

      return {
        success: false,
        createTime,
        execTime,
        error: errorMsg,
        sandboxName,
      };
    }
  } catch (createError) {
    // Try to cleanup if sandbox was partially created
    try {
      await SandboxInstance.delete(sandboxName);
    } catch {
      // Ignore cleanup errors
    }

    let errorMsg = "Unknown error";
    if (createError instanceof Error) {
      errorMsg = createError.message;
    }

    return {
      success: false,
      createTime: 0,
      execTime: 0,
      error: `Create failed: ${errorMsg}`,
      sandboxName,
    };
  }
}

async function main() {
  console.log("🚀 Starting fastrun test");
  console.log(`🖼️  Image: blaxel/base-image`);
  console.log(`🔁 Loop count: ${loopCount}\n`);

  const createTimes: number[] = [];
  const execTimes: number[] = [];
  let successCount = 0;
  let failureCount = 0;
  const errors: Array<{ iteration: number; error: string }> = [];

  const totalStart = Date.now();

  for (let i = 1; i <= loopCount; i++) {
    console.log(`\n[${i}/${loopCount}] Starting test iteration...`);

    const result = await runSingleTest(i);

    if (result.success) {
      successCount++;
      createTimes.push(result.createTime);
      execTimes.push(result.execTime);
      console.log(`✅ Iteration ${i} succeeded`);
      console.log(`   Create: ${result.createTime}ms | Exec: ${result.execTime}ms | Total: ${result.createTime + result.execTime}ms`);
    } else {
      failureCount++;
      console.error(`❌ Iteration ${i} failed`);
      console.error(`   Error: ${result.error}`);
      if (result.createTime > 0) {
        console.error(`   Create: ${result.createTime}ms | Exec: ${result.execTime}ms`);
      }
      errors.push({ iteration: i, error: result.error || "Unknown error" });
    }
  }

  const totalTime = Date.now() - totalStart;

  // Calculate statistics
  const avgCreateTime = createTimes.length > 0
    ? Math.round(createTimes.reduce((a, b) => a + b, 0) / createTimes.length)
    : 0;
  const avgExecTime = execTimes.length > 0
    ? Math.round(execTimes.reduce((a, b) => a + b, 0) / execTimes.length)
    : 0;
  const minCreateTime = createTimes.length > 0 ? Math.min(...createTimes) : 0;
  const maxCreateTime = createTimes.length > 0 ? Math.max(...createTimes) : 0;
  const minExecTime = execTimes.length > 0 ? Math.min(...execTimes) : 0;
  const maxExecTime = execTimes.length > 0 ? Math.max(...execTimes) : 0;

  // Print results summary
  console.log("\n========================================");
  console.log("           RESULTS SUMMARY");
  console.log("========================================");
  console.log(`Total iterations: ${loopCount}`);
  console.log(`Successful:       ${successCount}`);
  console.log(`Failed:           ${failureCount}`);
  console.log(`Success rate:     ${((successCount / loopCount) * 100).toFixed(1)}%`);
  console.log();
  if (createTimes.length > 0) {
    console.log(`Create times:`);
    console.log(`  Avg: ${avgCreateTime}ms | Min: ${minCreateTime}ms | Max: ${maxCreateTime}ms`);
  }
  if (execTimes.length > 0) {
    console.log(`Exec times:`);
    console.log(`  Avg: ${avgExecTime}ms | Min: ${minExecTime}ms | Max: ${maxExecTime}ms`);
  }
  console.log();
  console.log(`Total time:       ${totalTime}ms`);
  console.log(`Avg per cycle:    ${Math.round(totalTime / loopCount)}ms`);
  console.log("========================================");

  // Print error details if any
  if (errors.length > 0) {
    console.log("\n========================================");
    console.log("           ERROR DETAILS");
    console.log("========================================");
    errors.forEach(({ iteration, error }) => {
      console.log(`Iteration ${iteration}: ${error}`);
    });
    console.log("========================================");
  }

  // Exit with appropriate code
  if (failureCount > 0) {
    console.log(`\n⚠️  Test completed with ${failureCount} failure(s)`);
    process.exit(1);
  } else {
    console.log("\n✅ All tests completed successfully!");
  }
}

main().catch((err) => {
  console.error("❌ Unexpected error:", err);
  process.exit(1);
});

