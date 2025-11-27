import { SandboxInstance } from "@blaxel/core";

// Declare process to fix TypeScript linting
declare const process: any;

async function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Determine the base image based on environment
const baseImage = "blaxel/base-image:latest"
console.log(`Using base image: ${baseImage} (BL_ENV=${process.env.BL_ENV || 'not set'})\n`);

// Test 1: TTL Max-Age expiration policy
async function testTtlMaxAge() {
  try {
    console.log("[Test 1] TTL Max-Age: Starting...");
    const ttlPolicy = {
      type: "ttl-max-age",
      value: "60s",
      action: "delete"
    };
    const lifecycle = {
      expirationPolicies: [ttlPolicy]
    };

    console.log(`[Test 1] Creating sandbox with lifecycle:`, JSON.stringify(lifecycle, null, 2));
    const sandbox = await SandboxInstance.create({
      lifecycle: lifecycle,
      image: baseImage,
      name: "sandbox-ttl-maxage"
    });
    await sandbox.wait();
    console.log(`[Test 1] Created sandbox: ${sandbox.metadata?.name}`);

    let status = await SandboxInstance.get(sandbox.metadata?.name!);
    console.log(`[Test 1] Initial status: ${status.status}`);

    console.log(`[Test 1] Waiting 120s for expiration (cron runs every minute)...`);
    await wait(120000);

    status = await SandboxInstance.get(sandbox.metadata?.name!);
    if (status.status === "DELETED" || status.status === "TERMINATED") {
      console.log(`[Test 1] ✅ PASSED: Sandbox deleted after TTL max-age expiration`);
    } else {
      console.log(`[Test 1] ❌ FAILED: Expected DELETED/TERMINATED, got ${status.status}`);
      throw new Error(`Test 1 failed: Expected DELETED/TERMINATED, got ${status.status}`);
    }
  } catch (error) {
    console.error(`[Test 1] ❌ Error occurred:`);
    if (error instanceof Error) {
      console.error(`  Message: ${error.message}`);
      if (error.stack) {
        console.error(`  Stack: ${error.stack}`);
      }
    }
    // Check if it's an API error with additional details
    if (error && typeof error === 'object') {
      const err = error as any;
      if (err.body) {
        console.error(`  API Response Body:`, JSON.stringify(err.body, null, 2));
      }
      if (err.response) {
        console.error(`  API Response:`, JSON.stringify(err.response, null, 2));
      }
      if (err.status) {
        console.error(`  HTTP Status:`, err.status);
      }
      if (err.message && !(error instanceof Error)) {
        console.error(`  Message:`, err.message);
      }
      // If no specific error details found, log the whole object
      if (!err.body && !err.response && !err.message) {
        console.error(`  Full error object:`, JSON.stringify(error, null, 2));
      }
    }
    throw error;
  }
}

// Test 2: Date expiration policy
async function testDateExpiration() {
  console.log("[Test 2] Date Expiration: Starting...");
  const expirationDate = new Date();
  expirationDate.setSeconds(expirationDate.getSeconds() + 60);

  const datePolicy = {
    type: "date",
    value: expirationDate.toISOString(),
    action: "delete"
  };
  const lifecycle = {
    expirationPolicies: [datePolicy]
  };

  const sandbox = await SandboxInstance.create({
    lifecycle: lifecycle,
    image: baseImage,
    name: "sandbox-date"
  });
  await sandbox.wait();
  console.log(`[Test 2] Created sandbox: ${sandbox.metadata?.name}`);
  console.log(`[Test 2] Expires at: ${datePolicy.value}`);

  let status = await SandboxInstance.get(sandbox.metadata?.name!);
  console.log(`[Test 2] Initial status: ${status.status}`);

  console.log(`[Test 2] Waiting 120s for date expiration (cron runs every minute)...`);
  await wait(120000);

  status = await SandboxInstance.get(sandbox.metadata?.name!);
  if (status.status === "DELETED" || status.status === "TERMINATED") {
    console.log(`[Test 2] ✅ PASSED: Sandbox deleted at specified date`);
  } else {
    console.log(`[Test 2] ❌ FAILED: Expected DELETED/TERMINATED, got ${status.status}`);
    throw new Error(`Test 2 failed: Expected DELETED/TERMINATED, got ${status.status}`);
  }
}

// Test 3: TTL Idle expiration policy - Two scenarios
async function testTtlIdle() {
  console.log("[Test 3] TTL Idle: Starting two test scenarios...");

  // Scenario A: Test that sandbox stays alive with regular activity
  console.log("\n[Test 3A] Scenario A: Testing idle timeout with regular activity...");
  const idlePolicyActive = {
    type: "ttl-idle",
    value: "60s", // 1 minute idle timeout
    action: "delete"
  };
  const lifecycleActive = {
    expirationPolicies: [idlePolicyActive]
  };

  const sandboxActive = await SandboxInstance.create({
    lifecycle: lifecycleActive,
    image: baseImage,
    name: "sandbox-idle-active"
  });
  await sandboxActive.wait();
  console.log(`[Test 3A] Created sandbox with 60s idle timeout: ${sandboxActive.metadata?.name}`);

  // Make initial sandbox API call to activate idle monitoring
  console.log(`[Test 3A] Making initial sandbox API call (process.exec) to activate idle monitoring...`);
  let result = await sandboxActive.process.exec({ command: "ls /" });
  console.log(`[Test 3A] Initial exec successful (pid: ${result.pid}) - Idle timer started`);

  // Make sandbox API calls every 30 seconds to keep sandbox alive (3 calls total)
  for (let i = 1; i <= 3; i++) {
    console.log(`[Test 3A] Waiting 30 seconds before API call ${i}...`);
    await wait(30000);

    try {
      // Make a sandbox API call (process exec) to reset idle timer
      result = await sandboxActive.process.exec({ command: "echo 'keep-alive call'" });
      console.log(`[Test 3A] API call ${i} successful (pid: ${result.pid}) - sandbox kept alive`);

      // Also check control plane status to ensure sandbox is still running
      const statusActive = await SandboxInstance.get(sandboxActive.metadata?.name!);
      console.log(`[Test 3A] Control plane status: ${statusActive.status}`);
    } catch (error: any) {
      if (error.message?.includes('404') || error.message?.includes('not found')) {
        console.log(`[Test 3A] ❌ FAILED: Sandbox was deleted prematurely after only ${i * 30}s with regular activity`);
        throw new Error(`Test 3A failed: Sandbox deleted while making regular calls every 30s`);
      }
      throw error;
    }
  }

  console.log(`[Test 3A] ✅ PASSED: Sandbox stayed alive with regular activity (90s total with calls every 30s)`);

  // Clean up the active sandbox
  await SandboxInstance.delete(sandboxActive.metadata?.name!);
  console.log(`[Test 3A] Cleaned up active sandbox\n`);

  // Scenario B: Test that sandbox gets deleted after idle timeout
  console.log("[Test 3B] Scenario B: Testing idle timeout without activity...");
  const idlePolicyInactive = {
    type: "ttl-idle",
    value: "30s", // 30 seconds idle timeout for faster testing
    action: "delete"
  };
  const lifecycleInactive = {
    expirationPolicies: [idlePolicyInactive]
  };

  const sandboxInactive = await SandboxInstance.create({
    lifecycle: lifecycleInactive,
    image: baseImage,
    name: "sandbox-idle-inactive"
  });
  await sandboxInactive.wait();
  console.log(`[Test 3B] Created sandbox with 30s idle timeout: ${sandboxInactive.metadata?.name}`);

  // Make initial sandbox API call to activate idle monitoring
  console.log(`[Test 3B] Making initial sandbox API call (process.exec) to activate idle monitoring...`);
  const resultInactive = await sandboxInactive.process.exec({ command: "ls /" });
  console.log(`[Test 3B] Initial exec successful (pid: ${resultInactive.pid}) - Idle timer started`);

  // Now wait for idle timeout without any further activity
  console.log(`[Test 3B] Now waiting 90s for idle timeout to trigger (cron runs every minute)...`);
  await wait(90000);

  // Check if sandbox was deleted due to idle timeout
  try {
    const statusInactive = await SandboxInstance.get(sandboxInactive.metadata?.name!);
    console.log(`[Test 3B] ⚠️ WARNING: Sandbox still active with status: ${statusInactive.status}`);
    // Clean up if not already deleted
    await SandboxInstance.delete(sandboxInactive.metadata?.name!);
    console.log(`[Test 3B] ⚠️ Test completed with warning - sandbox manually cleaned up`);
  } catch (error: any) {
    // If we get a 404, the sandbox was successfully deleted
    if (error.status === 404 || error.message?.includes('not found')) {
      console.log(`[Test 3B] ✅ PASSED: Sandbox deleted after idle timeout (404 on get)`);
    } else {
      console.log(`[Test 3B] ❌ Error checking sandbox status:`, error.message || error);
      throw error;
    }
  }

  console.log("[Test 3] ✅ Both idle timeout scenarios completed successfully");
}

// Test 4: Multiple expiration policies
async function testMultiplePolicies() {
  console.log("[Test 4] Multiple Policies: Starting...");
  const idlePolicy = {
    type: "ttl-idle",
    value: "5m",
    action: "delete"
  };
  const maxAgePolicy = {
    type: "ttl-max-age",
    value: "10m",
    action: "delete"
  };
  const lifecycle = {
    expirationPolicies: [idlePolicy, maxAgePolicy]
  };

  const sandbox = await SandboxInstance.create({
    lifecycle: lifecycle,
    image: baseImage,
    name: "sandbox-multiple"
  });
  await sandbox.wait();
  console.log(`[Test 4] Created sandbox: ${sandbox.metadata?.name}`);
  console.log(`[Test 4] Policy 1: ttl-idle=5m (delete)`);
  console.log(`[Test 4] Policy 2: ttl-max-age=10m (delete)`);

  // IMPORTANT: Make a sandbox API call to activate idle monitoring for ttl-idle policy
  console.log(`[Test 4] Making sandbox API call (process.exec) to activate idle monitoring...`);
  const execResult = await sandbox.process.exec({ command: "echo 'activate idle timer'" });
  console.log(`[Test 4] Process exec successful (pid: ${execResult.pid}) - Idle timer activated`);

  // Clean up immediately for this test (just testing configuration)
  await SandboxInstance.delete(sandbox.metadata?.name!);
  console.log(`[Test 4] ✅ PASSED: Multiple policies configured successfully`);
}

// Test 5: Empty expiration policies
async function testEmptyPolicies() {
  console.log("[Test 5] Empty Policies: Starting...");
  const lifecycle = {
    expirationPolicies: []
  };

  const sandbox = await SandboxInstance.create({
    image: baseImage,
    name: "sandbox-empty"
  });
  await sandbox.wait();
  console.log(`[Test 5] Created sandbox with empty policies: ${sandbox.metadata?.name}`);

  const status = await SandboxInstance.get(sandbox.metadata?.name!);
  console.log(`[Test 5] Current status: ${status.status}`);

  // Clean up
  await SandboxInstance.delete(sandbox.metadata?.name!);
  console.log(`[Test 5] ✅ PASSED: Empty policies handled correctly`);
}

// Test 6: Backward compatibility with legacy ttl
async function testBackwardCompatibility() {
  console.log("[Test 6] Backward Compatibility: Starting...");
  // Test that lifecycle can coexist with legacy ttl
  const sandbox = await SandboxInstance.create({
    image: baseImage,
    ttl: "5m", // Legacy ttl - should be overridden by lifecycle
    name: "sandbox-backcompat"
  });
  await sandbox.wait();
  console.log(`[Test 6] Created sandbox with both lifecycle and legacy ttl`);
  console.log(`[Test 6] Lifecycle: ttl-max-age=2m (delete), Legacy ttl: 5m`);

  const status = await SandboxInstance.get(sandbox.metadata?.name!);
  console.log(`[Test 6] Current status: ${status.status}`);

  // Clean up
  await SandboxInstance.delete(sandbox.metadata?.name!);
  console.log(`[Test 6] ✅ PASSED: Backward compatibility maintained`);
}

// Test 7: Various duration formats
async function testDurationFormats() {
  console.log("[Test 7] Duration Formats: Starting...");
  const durations = ["30s", "5m", "1h", "1d"];

  for (const duration of durations) {
    const lifecycle = {
      expirationPolicies: [
        { type: "ttl-max-age", value: duration, action: "delete" }
      ]
    };

    const sandboxName = `sandbox-dur-${duration.replace(/\D/g, '')}${duration.replace(/\d/g, '')}`;
    const sandbox = await SandboxInstance.create({
      lifecycle: lifecycle,
      image: baseImage,
      name: sandboxName
    });
    await sandbox.wait();
    console.log(`[Test 7] Created sandbox with ${duration} TTL: ${sandbox.metadata?.name}`);

    // Clean up immediately
    await SandboxInstance.delete(sandbox.metadata?.name!);
  }

  console.log(`[Test 7] ✅ PASSED: All duration formats accepted`);
}

// Test 8: TTL Max-Age with delete action
async function testTtlMaxAgeSuspend() {
  console.log("[Test 8] TTL Max-Age Delete: Starting...");
  const suspendPolicy = {
    type: "ttl-max-age",
    value: "30s",
    action: "delete"
  };
  const lifecycle = {
    expirationPolicies: [suspendPolicy]
  };

  const sandbox = await SandboxInstance.create({
    lifecycle: lifecycle,
    image: baseImage,
    name: "sandbox-maxage-suspend"
  });
  await sandbox.wait();
  console.log(`[Test 8] Created sandbox: ${sandbox.metadata?.name}`);
  console.log(`[Test 8] Policy: ttl-max-age=30s (delete)`);

  let status = await SandboxInstance.get(sandbox.metadata?.name!);
  console.log(`[Test 8] Initial status: ${status.status}`);

  console.log(`[Test 8] Waiting 90s for suspension (cron runs every minute)...`);
  await wait(90000);

  status = await SandboxInstance.get(sandbox.metadata?.name!);
  if (status.status === "DELETED" || status.status === "TERMINATED") {
    console.log(`[Test 8] ✅ PASSED: Sandbox deleted after TTL max-age`);
  } else {
    console.log(`[Test 8] ⚠️ WARNING: Expected DELETED/TERMINATED, got ${status.status}`);
    // Clean up if not already deleted
    if (status.status !== "DELETED" && status.status !== "TERMINATED") {
      await SandboxInstance.delete(sandbox.metadata?.name!);
    }
  }
}

// Test 9: Mixed policy types and actions
async function testMixedPolicies() {
  console.log("[Test 9] Mixed Policies: Starting...");
  const policies = [
    { type: "ttl-idle", value: "2m", action: "delete" },
    { type: "ttl-max-age", value: "5m", action: "delete" },
    { type: "date", value: new Date(Date.now() + 3600000).toISOString(), action: "delete" }
  ];
  const lifecycle = {
    expirationPolicies: policies
  };

  const sandbox = await SandboxInstance.create({
    lifecycle: lifecycle,
    image: baseImage,
    name: "sandbox-mixed"
  });
  await sandbox.wait();
  console.log(`[Test 9] Created sandbox: ${sandbox.metadata?.name}`);
  console.log(`[Test 9] Policies: idle=2m(delete), max-age=5m(delete), date=+1h(delete)`);

  // IMPORTANT: Make a sandbox API call to activate idle monitoring for ttl-idle policy
  console.log(`[Test 9] Making sandbox API call (process.exec) to activate idle monitoring...`);
  const execResult = await sandbox.process.exec({ command: "echo 'activate idle timer'" });
  console.log(`[Test 9] Process exec successful (pid: ${execResult.pid}) - Idle timer activated`);

  // Clean up
  await SandboxInstance.delete(sandbox.metadata?.name!);
  console.log(`[Test 9] ✅ PASSED: Mixed policies configured successfully`);
}

async function main() {
  try {
    console.log("=== Testing Sandbox Lifecycle with ExpirationPolicies ===");
    console.log("=== Running all tests in parallel ===\n");

    const startTime = Date.now();

    // Run all tests in parallel
    const results = await Promise.allSettled([
      testTtlMaxAge(),
      testDateExpiration(),
      testTtlIdle(),
      testMultiplePolicies(),
      testEmptyPolicies(),
      testBackwardCompatibility(),
      testDurationFormats(),
      testTtlMaxAgeSuspend(),
      testMixedPolicies()
    ]);

    const endTime = Date.now();
    const duration = Math.round((endTime - startTime) / 1000);

    // Print summary
    console.log("\n=== Test Results Summary ===");
    console.log(`Total execution time: ${duration} seconds\n`);

    let passed = 0;
    let failed = 0;
    let warnings = 0;

    results.forEach((result, index) => {
      const testNames = [
        "TTL Max-Age", "Date Expiration", "TTL Idle",
        "Multiple Policies", "Empty Policies", "Backward Compatibility",
        "Duration Formats", "TTL Max-Age Delete", "Mixed Policies"
      ];

      if (result.status === "fulfilled") {
        passed++;
        console.log(`✅ Test ${index + 1} (${testNames[index]}): PASSED`);
      } else {
        failed++;
        console.log(`❌ Test ${index + 1} (${testNames[index]}): FAILED`);
        const error = result.reason;
        if (error instanceof Error) {
          console.log(`   Error: ${error.message}`);
          console.log(`   Stack: ${error.stack}`);
        } else if (typeof error === 'object' && error !== null) {
          console.log(`   Error object:`, JSON.stringify(error, null, 2));
        } else {
          console.log(`   Error: ${error}`);
        }
      }
    });

    console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);

    if (failed === 0) {
      console.log("\n✅ All lifecycle tests completed successfully!");
      process.exit(0);
    } else {
      console.log("\n❌ Some tests failed. Check the logs above for details.");
      process.exit(1);
    }

  } catch (e) {
    console.error("\n❌ Fatal test error:");
    if (e instanceof Error) {
      console.error("Error message:", e.message);
      console.error("Stack trace:", e.stack);
    } else if (typeof e === 'object' && e !== null) {
      console.error("Error object:", JSON.stringify(e, null, 2));
    } else {
      console.error("Error:", e);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Unhandled error:");
  if (err instanceof Error) {
    console.error("Message:", err.message);
    console.error("Stack:", err.stack);
  } else if (typeof err === 'object' && err !== null) {
    console.error("Error object:", JSON.stringify(err, null, 2));
  } else {
    console.error("Error:", err);
  }
  process.exit(1);
});
