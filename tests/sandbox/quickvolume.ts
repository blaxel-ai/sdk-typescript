/**
 * Volume Health Check Test
 *
 * Tests volume functionality by creating volumes, attaching them to sandboxes,
 * writing files, and reading them back. Supports parallel execution for load testing.
 *
 * Usage:
 *   tsx tests/sandbox/quickvolume.ts [NUM_CHECKS] [PARALLELISM]
 *
 * Examples:
 *   tsx tests/sandbox/quickvolume.ts                    # Single check
 *   tsx tests/sandbox/quickvolume.ts 10                 # 10 checks sequentially
 *   tsx tests/sandbox/quickvolume.ts 10 3               # 10 checks, 3 in parallel
 *
 * Environment Variables:
 *   NUM_CHECKS   - Number of checks to run (default: 1)
 *   PARALLELISM  - Number of parallel checks (default: 1)
 *   BL_ENV       - Blaxel environment: dev/prod (default: prod)
 *   BL_REGION    - Region to use (default: us-pdx-1 for prod, eu-dub-1 for dev)
 *
 * What it tests:
 *   1. Volume creation time
 *   2. Sandbox creation with volume attached
 *   3. File write to volume
 *   4. File read from volume
 *   5. Content verification
 *   6. Cleanup (sandbox + volume deletion)
 *
 * Outputs:
 *   - Individual check results with timings
 *   - Summary statistics (success/failure rates, average timings)
 *   - Error breakdown by type
 */
import { SandboxInstance, VolumeInstance } from "@blaxel/core";

const BL_ENV = process.env.BL_ENV || "prod";
const BL_REGION = process.env.BL_REGION || (BL_ENV === "dev" ? "eu-dub-1" : "us-pdx-1");

/**
 * Waits for a sandbox deletion to fully complete by polling until the sandbox no longer exists
 */
async function waitForSandboxDeletion(sandboxName: string, maxAttempts: number = 30): Promise<boolean> {
  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      await SandboxInstance.get(sandboxName);
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    } catch (error) {
      return true;
    }
  }
  return false;
}

/**
 * Waits for a volume deletion to fully complete by polling until the volume no longer exists
 */
async function waitForVolumeDeletion(volumeName: string, maxAttempts: number = 30): Promise<boolean> {
  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      await VolumeInstance.get(volumeName);
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    } catch (error) {
      return true;
    }
  }
  return false;
}

interface VolumeCheckResult {
  volumeName: string;
  sandboxName: string;
  volumeCreationTime: number;
  sandboxCreationTime: number;
  fileWriteTime: number;
  fileReadTime: number;
  totalTime: number;
  success: boolean;
  error?: string;
  fileContent?: string;
  expectedContent?: string;
}

async function runVolumeCheck(): Promise<VolumeCheckResult> {
  const startTime = Date.now();
  const randomVolumeName = `volume-test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const randomSandboxName = `sandbox-volume-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const testFileName = "test-file.txt";
  const testContent = `Hello from volume test at ${new Date().toISOString()}`;

  let volume: VolumeInstance | null = null;
  let sandbox: SandboxInstance | null = null;

  try {
    // Create volume
    const volumeStartTime = Date.now();
    volume = await VolumeInstance.create({
      name: randomVolumeName,
      region: BL_REGION,
    });
    const volumeCreationTime = Date.now() - volumeStartTime;

    // Create sandbox with volume attached
    const sandboxStartTime = Date.now();
    sandbox = await SandboxInstance.create({
      name: randomSandboxName,
      image: "blaxel/base-image:latest",
      memory: 4096,
      region: BL_REGION,
      volumes: [
        {
          name: randomVolumeName,
          mountPath: "/mnt/test-volume",
          readOnly: false,
        },
      ],
    });
    const sandboxCreationTime = Date.now() - sandboxStartTime;

    // Write file to volume using process.exec (like in the example)
    const writeStartTime = Date.now();
    await sandbox.process.exec({
      command: `echo '${testContent}' > /mnt/test-volume/${testFileName}`,
      waitForCompletion: true,
    });
    const fileWriteTime = Date.now() - writeStartTime;

    // Read file back from volume using process.exec
    const readStartTime = Date.now();
    const readResult = await sandbox.process.exec({
      command: `cat /mnt/test-volume/${testFileName}`,
      waitForCompletion: true,
    });
    const fileContent = readResult.logs?.trim() || "";
    const fileReadTime = Date.now() - readStartTime;

    const totalTime = Date.now() - startTime;

    // Verify content matches
    const contentMatches = fileContent === testContent;

    // Clean up and wait for completion
    await SandboxInstance.delete(randomSandboxName).catch(() => {});
    await waitForSandboxDeletion(randomSandboxName);
    await VolumeInstance.delete(randomVolumeName).catch(() => {});
    await waitForVolumeDeletion(randomVolumeName);

    return {
      volumeName: randomVolumeName,
      sandboxName: randomSandboxName,
      volumeCreationTime,
      sandboxCreationTime,
      fileWriteTime,
      fileReadTime,
      totalTime,
      success: contentMatches,
      error: contentMatches ? undefined : "File content mismatch",
      fileContent,
      expectedContent: testContent,
    };
  } catch (error) {
    // Try to clean up on error
    try {
      await SandboxInstance.delete(randomSandboxName).catch(() => {});
      await waitForSandboxDeletion(randomSandboxName);
      await VolumeInstance.delete(randomVolumeName).catch(() => {});
      await waitForVolumeDeletion(randomVolumeName);
    } catch {}

    // Better error serialization
    let errorMessage: string;
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'object' && error !== null) {
      errorMessage = JSON.stringify(error, null, 2);
    } else {
      errorMessage = String(error);
    }

    return {
      volumeName: randomVolumeName,
      sandboxName: randomSandboxName,
      volumeCreationTime: 0,
      sandboxCreationTime: 0,
      fileWriteTime: 0,
      fileReadTime: 0,
      totalTime: Date.now() - startTime,
      success: false,
      error: errorMessage,
    };
  }
}

async function main() {
  // Get parameters from command line or environment
  const numChecks = parseInt(process.argv[2] || process.env.NUM_CHECKS || "1", 10);
  const parallelism = parseInt(process.argv[3] || process.env.PARALLELISM || "1", 10);

  console.log(`Running ${numChecks} volume check(s) with parallelism of ${parallelism}`);
  console.log(`Environment: ${BL_ENV}`);
  console.log(`Region: ${BL_REGION}`);
  console.log("---");

  const results: VolumeCheckResult[] = [];

  // Run volume checks with specified parallelism
  for (let i = 0; i < numChecks; i += parallelism) {
    const batch = Math.min(parallelism, numChecks - i);
    const promises = Array.from({ length: batch }, () => runVolumeCheck());

    console.log(`Running batch ${Math.floor(i / parallelism) + 1}/${Math.ceil(numChecks / parallelism)} (${batch} parallel check(s))...`);
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);

    // Log individual results
    batchResults.forEach((result, idx) => {
      const checkNum = i + idx + 1;
      if (result.success) {
        console.log(`  [${checkNum}] ✓ ${result.volumeName} → ${result.sandboxName}`);
        console.log(`      Volume creation: ${result.volumeCreationTime}ms`);
        console.log(`      Sandbox creation: ${result.sandboxCreationTime}ms`);
        console.log(`      File write: ${result.fileWriteTime}ms`);
        console.log(`      File read: ${result.fileReadTime}ms`);
        console.log(`      Total: ${result.totalTime}ms`);
      } else {
        console.log(`  [${checkNum}] ✗ ${result.volumeName} → ${result.sandboxName}`);
        console.log(`      Error: ${result.error}`);
        if (result.fileContent !== undefined && result.expectedContent !== undefined) {
          console.log(`      Expected: "${result.expectedContent}"`);
          console.log(`      Got: "${result.fileContent}"`);
        }
      }
    });

  }

  // Summary statistics
  console.log("\n=== SUMMARY ===");
  const successfulResults = results.filter(r => r.success);
  const failedResults = results.filter(r => !r.success);

  console.log(`Total checks: ${results.length}`);
  console.log(`Successful: ${successfulResults.length}`);
  console.log(`Failed: ${failedResults.length}`);

  if (successfulResults.length > 0) {
    const avgVolumeCreation = successfulResults.reduce((sum, r) => sum + r.volumeCreationTime, 0) / successfulResults.length;
    const avgSandboxCreation = successfulResults.reduce((sum, r) => sum + r.sandboxCreationTime, 0) / successfulResults.length;
    const avgFileWrite = successfulResults.reduce((sum, r) => sum + r.fileWriteTime, 0) / successfulResults.length;
    const avgFileRead = successfulResults.reduce((sum, r) => sum + r.fileReadTime, 0) / successfulResults.length;
    const avgTotal = successfulResults.reduce((sum, r) => sum + r.totalTime, 0) / successfulResults.length;

    const minTotal = Math.min(...successfulResults.map(r => r.totalTime));
    const maxTotal = Math.max(...successfulResults.map(r => r.totalTime));

    console.log("\nAverage timings:");
    console.log(`  Volume creation: ${avgVolumeCreation.toFixed(0)}ms`);
    console.log(`  Sandbox creation: ${avgSandboxCreation.toFixed(0)}ms`);
    console.log(`  File write: ${avgFileWrite.toFixed(0)}ms`);
    console.log(`  File read: ${avgFileRead.toFixed(0)}ms`);
    console.log(`  Total: ${avgTotal.toFixed(0)}ms`);

    console.log("\nTotal time range:");
    console.log(`  Min: ${minTotal}ms`);
    console.log(`  Max: ${maxTotal}ms`);
  }

  if (failedResults.length > 0) {
    console.log("\nFailed checks:");
    failedResults.forEach((result, idx) => {
      console.log(`  ${idx + 1}. ${result.volumeName} → ${result.sandboxName}: ${result.error}`);
    });

    // Group errors by message
    console.log("\nErrors by type:");
    const errorsByType = new Map<string, number>();
    failedResults.forEach((result) => {
      const errorMsg = result.error || "unknown error";
      errorsByType.set(errorMsg, (errorsByType.get(errorMsg) || 0) + 1);
    });

    Array.from(errorsByType.entries())
      .sort((a, b) => b[1] - a[1]) // Sort by count descending
      .forEach(([error, count]) => {
        console.log(`  ${error}: ${count} occurrence(s)`);
      });
  }
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .then(() => {
    process.exit(0);
  });
