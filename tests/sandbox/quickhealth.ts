import { SandboxInstance, settings } from "@blaxel/core";

const BL_ENV = process.env.BL_ENV || "prod";
const BL_REGION = process.env.BL_REGION || (BL_ENV === "dev" ? "eu-dub-1" : "us-pdx-1");

interface HealthCheckResult {
  sandboxName: string;
  sandboxCreationTime: number;
  healthCheckTime: number;
  availabilityGap: number;
  totalTime: number;
  success: boolean;
  httpStatus?: number;
  error?: string;
}

async function runHealthCheck(): Promise<HealthCheckResult> {
  const startTime = Date.now();
  const randomSandboxName = `sandbox-health-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  try {
    // Create sandbox
    const sandboxStartTime = Date.now();
    const sandbox = await SandboxInstance.create({
      name: randomSandboxName,
      image: "ttyd:latest",
      memory: 4096,
      region: BL_REGION,
    });
    const sandboxCreationTime = Date.now() - sandboxStartTime;

    // Immediately call the health endpoint (already available in base image)
    const healthCheckStartTime = Date.now();

    // Get the sandbox host for direct HTTP call
    const sandboxHost = sandbox.metadata?.url;

    // Make the health check request
    // console.log(`curl ${sandboxHost}/health -H "Authorization: ${settings.authorization}"`);
    const healthResponse = await fetch(`${sandboxHost}/health`, {
      method: "GET",
      headers: {
        "Authorization": settings.authorization,
      },
    });

    const healthCheckTime = Date.now() - healthCheckStartTime;
    const availabilityGap = Date.now() - (startTime + sandboxCreationTime);
    const totalTime = Date.now() - startTime;

    // Check the status code - catch all 400+ errors
    if (healthResponse.status >= 400) {
      let errorMessage = `HTTP ${healthResponse.status} - ${healthResponse.statusText}`;

      // Clean up before returning error
      await SandboxInstance.delete(randomSandboxName).catch(() => {});

      return {
        sandboxName: randomSandboxName,
        sandboxCreationTime,
        healthCheckTime,
        availabilityGap,
        totalTime,
        success: false,
        httpStatus: healthResponse.status,
        error: errorMessage,
      };
    }

    // Try to parse the JSON response
    let healthData;
    try {
      healthData = await healthResponse.json();
    } catch (parseError) {
      // Clean up before returning error
      await SandboxInstance.delete(randomSandboxName).catch(() => {});

      return {
        sandboxName: randomSandboxName,
        sandboxCreationTime,
        healthCheckTime,
        availabilityGap,
        totalTime,
        success: false,
        httpStatus: healthResponse.status,
        error: "Failed to parse JSON response",
      };
    }

    // Clean up
    await SandboxInstance.delete(randomSandboxName).catch(() => {
      // Ignore cleanup errors
    });

    return {
      sandboxName: randomSandboxName,
      sandboxCreationTime,
      healthCheckTime,
      availabilityGap,
      totalTime,
      success: true,
      httpStatus: healthResponse.status,
    };
  } catch (error) {
    // Try to clean up on error
    try {
      await SandboxInstance.delete(randomSandboxName).catch(() => {});
    } catch {}

    return {
      sandboxName: randomSandboxName,
      sandboxCreationTime: 0,
      healthCheckTime: 0,
      availabilityGap: 0,
      totalTime: Date.now() - startTime,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  // Get parameters from command line or environment
  const numChecks = parseInt(process.argv[2] || process.env.NUM_CHECKS || "1", 10);
  const parallelism = parseInt(process.argv[3] || process.env.PARALLELISM || "1", 10);

  console.log(`Running ${numChecks} health check(s) with parallelism of ${parallelism}`);
  console.log(`Environment: ${BL_ENV}`);
  console.log(`Region: ${BL_REGION}`);
  console.log("---");

  const results: HealthCheckResult[] = [];

  // Run health checks with specified parallelism
  for (let i = 0; i < numChecks; i += parallelism) {
    const batch = Math.min(parallelism, numChecks - i);
    const promises = Array.from({ length: batch }, () => runHealthCheck());

    console.log(`Running batch ${Math.floor(i / parallelism) + 1}/${Math.ceil(numChecks / parallelism)} (${batch} parallel check(s))...`);
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);

    // Log individual results
    batchResults.forEach((result, idx) => {
      const checkNum = i + idx + 1;
      if (result.success) {
        console.log(`  [${checkNum}] ✓ ${result.sandboxName}`);
        console.log(`      Sandbox creation: ${result.sandboxCreationTime}ms`);
        console.log(`      Health check: ${result.healthCheckTime}ms (HTTP ${result.httpStatus})`);
        console.log(`      Availability gap: ${result.availabilityGap}ms`);
        console.log(`      Total: ${result.totalTime}ms`);
      } else {
        console.log(`  [${checkNum}] ✗ ${result.sandboxName}`);
        console.log(`      Error: ${result.error}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}`);
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
    const avgSandboxCreation = successfulResults.reduce((sum, r) => sum + r.sandboxCreationTime, 0) / successfulResults.length;
    const avgHealthCheck = successfulResults.reduce((sum, r) => sum + r.healthCheckTime, 0) / successfulResults.length;
    const avgAvailabilityGap = successfulResults.reduce((sum, r) => sum + r.availabilityGap, 0) / successfulResults.length;
    const avgTotal = successfulResults.reduce((sum, r) => sum + r.totalTime, 0) / successfulResults.length;

    const minAvailabilityGap = Math.min(...successfulResults.map(r => r.availabilityGap));
    const maxAvailabilityGap = Math.max(...successfulResults.map(r => r.availabilityGap));

    console.log("\nAverage timings:");
    console.log(`  Sandbox creation: ${avgSandboxCreation.toFixed(0)}ms`);
    console.log(`  Health check: ${avgHealthCheck.toFixed(0)}ms`);
    console.log(`  Availability gap: ${avgAvailabilityGap.toFixed(0)}ms`);
    console.log(`  Total: ${avgTotal.toFixed(0)}ms`);

    console.log("\nAvailability gap range:");
    console.log(`  Min: ${minAvailabilityGap}ms`);
    console.log(`  Max: ${maxAvailabilityGap}ms`);
  }

  if (failedResults.length > 0) {
    console.log("\nFailed checks:");
    failedResults.forEach((result, idx) => {
      console.log(`  ${idx + 1}. ${result.sandboxName}: ${result.error}`);
    });

    // Group errors by HTTP status
    console.log("\nErrors by HTTP status:");
    const errorsByStatus = new Map<number | string, number>();
    failedResults.forEach((result) => {
      const key = result.httpStatus ? result.httpStatus : "network/other";
      errorsByStatus.set(key, (errorsByStatus.get(key) || 0) + 1);
    });

    Array.from(errorsByStatus.entries())
      .sort((a, b) => {
        // Sort numbers first, then "network/other"
        if (typeof a[0] === "number" && typeof b[0] === "number") {
          return a[0] - b[0];
        }
        if (typeof a[0] === "number") return -1;
        if (typeof b[0] === "number") return 1;
        return 0;
      })
      .forEach(([status, count]) => {
        console.log(`  ${status}: ${count} occurrence(s)`);
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

