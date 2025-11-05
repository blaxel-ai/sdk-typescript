import { SandboxInstance } from "@blaxel/core";

// Determine environment
const env = process.env.BL_ENV === 'dev' ? 'dev' : 'prod';
console.log(`Running image tests with environment: ${env} (BL_ENV=${process.env.BL_ENV || 'not set'})\n`);

// Define legacy images (will use env prefix)
const legacyImages = [
  'base',
  'expo',
  'nextjs',
  'node',
  'py-app',
  'ts-app',
  'vite',
];

// Define new syntax images (no env prefix)
const newSyntaxImages = [
  'base-image',  // Note: this is the new name for base
  'expo',
  'nextjs',
  'node',
  'py-app',
  'ts-app',
  'vite',
];

async function testImageCreation(imageName: string, testName: string): Promise<void> {
  console.log(`\n=== ${testName} ===`);
  console.log(`Creating sandbox with image: ${imageName}`);

  const sandboxName = `sandbox-${imageName.replace(/[/:]/g, '-').replace('blaxel-', '')}-${Date.now()}`;

  try {
    // Create sandbox
    const sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: imageName,
    });

    console.log(`  ✓ Created sandbox: ${sandbox.metadata?.name}`);

    // Wait for sandbox to be ready
    await sandbox.wait();
    console.log(`  ✓ Sandbox is ready with status: ${sandbox.status}`);

    // Verify we can interact with it
    const execResult = await sandbox.process.exec({ command: "echo 'Hello from sandbox'" });
    console.log(`  ✓ Successfully executed command (pid: ${execResult.pid})`);

    // Delete sandbox
    await SandboxInstance.delete(sandboxName);
    console.log(`  ✓ Deleted sandbox: ${sandboxName}`);

    // Verify deletion
    try {
      const status = await SandboxInstance.get(sandboxName);
      if (status.status === "DELETED" || status.status === "TERMINATED") {
        console.log(`  ✓ Confirmed sandbox is ${status.status}`);
      } else {
        console.log(`  ⚠ Sandbox status after delete: ${status.status}`);
      }
    } catch (error) {
      // Might throw if sandbox no longer exists, which is also acceptable
      console.log(`  ✓ Sandbox no longer exists (fully deleted)`);
    }

    console.log(`✅ ${testName} PASSED`);

  } catch (error) {
    console.error(`❌ ${testName} FAILED`);
    console.error(`  Error: ${error}`);

    // Try to clean up on failure
    try {
      await SandboxInstance.delete(sandboxName);
      console.log(`  Cleaned up failed sandbox: ${sandboxName}`);
    } catch (cleanupError) {
      // Ignore cleanup errors
    }

    throw error;
  }
}

async function main() {
  let failedTests: string[] = [];
  let passedTests: string[] = [];

  console.log("========================================");
  console.log("SANDBOX IMAGE COMPATIBILITY TEST SUITE");
  console.log("========================================");

  // Test 1: Legacy images with environment prefix
  console.log("\n📦 TESTING LEGACY IMAGES (with env prefix)");
  console.log("==========================================");

  for (const image of legacyImages) {
    const fullImageName = `blaxel/${env}-${image}:latest`;
    const testName = `Legacy Image: ${fullImageName}`;

    try {
      await testImageCreation(fullImageName, testName);
      passedTests.push(testName);
    } catch (error) {
      failedTests.push(testName);
      console.error(`Failed to test ${fullImageName}: ${error}`);
    }

    // Small delay between tests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Test 2: New syntax images (no env prefix)
  console.log("\n📦 TESTING NEW SYNTAX IMAGES (no env prefix)");
  console.log("===========================================");

  for (const image of newSyntaxImages) {
    const fullImageName = `blaxel/${image}:latest`;
    const testName = `New Syntax Image: ${fullImageName}`;

    try {
      await testImageCreation(fullImageName, testName);
      passedTests.push(testName);
    } catch (error) {
      failedTests.push(testName);
      console.error(`Failed to test ${fullImageName}: ${error}`);
    }

    // Small delay between tests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Print summary
  console.log("\n========================================");
  console.log("TEST SUMMARY");
  console.log("========================================");
  console.log(`✅ Passed: ${passedTests.length} tests`);
  console.log(`❌ Failed: ${failedTests.length} tests`);

  if (passedTests.length > 0) {
    console.log("\nPassed Tests:");
    passedTests.forEach(test => console.log(`  ✓ ${test}`));
  }

  if (failedTests.length > 0) {
    console.log("\nFailed Tests:");
    failedTests.forEach(test => console.log(`  ✗ ${test}`));
    console.log("\n❌ SOME TESTS FAILED ❌");
    process.exit(1);
  } else {
    console.log("\n✅✅✅ ALL TESTS PASSED ✅✅✅");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("❌ Unexpected error in main:", err);
  import('util').then(util => {
    console.error(util.inspect(err, { depth: null }));
  });
  process.exit(1);
});
