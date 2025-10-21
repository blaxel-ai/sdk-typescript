import { SandboxInstance } from "@blaxel/core";

// Determine base image based on environment
const baseImage = process.env.BL_ENV === 'dev' ? "blaxel/vite:latest" : "blaxel/prod-base:latest";
console.log(`Using base image: ${baseImage} (BL_ENV=${process.env.BL_ENV || 'not set'})\n`);

async function waitForTermination(sandboxName: string, maxMinutes: number = 10): Promise<boolean> {
  console.log(`Checking sandbox status every minute for up to ${maxMinutes} minutes...`);

  for (let minute = 1; minute <= maxMinutes; minute++) {
    // Wait 1 minute
    await new Promise(resolve => setTimeout(resolve, 60000));

    // Check sandbox status
    const sandboxStatus = await SandboxInstance.get(sandboxName);
    console.log(`  Minute ${minute}: Status = ${sandboxStatus.status}`);

    if (sandboxStatus.status === "TERMINATED" || sandboxStatus.status === "DELETED") {
      console.log(`✅ Sandbox terminated after ${minute} minute(s)`);
      return true;
    }
  }

  return false;
}

async function main() {
  try {
    const sandboxName = "sandbox-ttl-idle";

    console.log("=== Test 1: Create sandbox with ttl-idle expiration policy ===");

    // Create sandbox with ttl-idle expiration policy of 20 seconds
    let sandbox = await SandboxInstance.createIfNotExists({
      name: sandboxName,
      image: baseImage,
      lifecycle: {
        expirationPolicies: [
          {
            type: 'ttl-idle',
            value: '20s',
            action: 'delete',
          },
        ],
      },
    });

    await sandbox.wait();
    console.log(`✅ Created sandbox with ttl-idle policy: ${sandbox.metadata?.name}`);

    // IMPORTANT: Make a sandbox API call to activate idle monitoring for ttl-idle policy
    console.log("Making sandbox API call to activate idle monitoring...");
    let execResult = await sandbox.process.exec({ command: "echo 'activate idle timer'" });
    console.log(`Process exec successful (pid: ${execResult.pid}) - Idle timer activated`);

    // Test 1.5: Try to create a sandbox with the same name while the first one is still running
    console.log("\n=== Test 1.5: Attempt to createIfNotExists with same name while running ===");
    console.log("Attempting to createIfNotExists with duplicate name (should return existing sandbox)...");

    const duplicateSandbox = await SandboxInstance.createIfNotExists({
      name: sandboxName,
      image: baseImage,
      lifecycle: {
        expirationPolicies: [
          {
            type: 'ttl-idle',
            value: '20s',
            action: 'delete',
          },
        ],
      },
    });

    // With createIfNotExists, we should get the existing active sandbox
    if (duplicateSandbox.metadata?.name === sandboxName && (duplicateSandbox.status === "RUNNING" || duplicateSandbox.status === "DEPLOYED")) {
      console.log("✅ Test 1.5 PASSED: createIfNotExists correctly returned the existing active sandbox");
      console.log(`  Returned sandbox: ${duplicateSandbox.metadata.name}, Status: ${duplicateSandbox.status}`);
    } else {
      console.log("❌ Test 1.5 FAILED: createIfNotExists did not return the expected active sandbox");
      console.log(`  Got: ${duplicateSandbox.metadata?.name}, Status: ${duplicateSandbox.status}`);
      process.exit(1);
    }

    console.log("\nContinuing with original sandbox termination test...");

    // Wait for termination (checking every minute for up to 10 minutes)
    const terminated1 = await waitForTermination(sandboxName, 10);

    if (terminated1) {
      console.log("✅ Test 1 PASSED: Sandbox was terminated due to idle timeout.");
    } else {
      console.log("❌ Test 1 FAILED: Sandbox was not terminated within 10 minutes.");

      // Clean up if not terminated
      const finalStatus = await SandboxInstance.get(sandboxName);
      if (finalStatus.status === "RUNNING" || finalStatus.status === "DEPLOYED") {
        await SandboxInstance.delete(sandboxName);
        console.log("Cleaned up sandbox manually.");
      }
      process.exit(1);
    }

    console.log("\n=== Test 2: Use createIfNotExists with same name after termination ===");
    console.log("Using createIfNotExists with the same name - should automatically recreate since previous is TERMINATED...");

    // Create another sandbox with the same name
    sandbox = await SandboxInstance.createIfNotExists({
      name: sandboxName,
      image: baseImage,
      lifecycle: {
        expirationPolicies: [
          {
            type: 'ttl-idle',
            value: '20s',
            action: 'delete',
          },
        ],
      },
    });

    await sandbox.wait();
    console.log(`✅ Successfully created new sandbox with same name: ${sandbox.metadata?.name}`);

    // Activate idle monitoring again
    console.log("Making sandbox API call to activate idle monitoring...");
    execResult = await sandbox.process.exec({ command: "echo 'activate idle timer for second sandbox'" });
    console.log(`Process exec successful (pid: ${execResult.pid}) - Idle timer activated`);

    // Wait for second sandbox termination
    const terminated2 = await waitForTermination(sandboxName, 10);

    if (terminated2) {
      console.log("✅ Test 2 PASSED: Second sandbox was also terminated due to idle timeout.");
      console.log("\n✅✅✅ ALL TESTS PASSED ✅✅✅");
    } else {
      console.log("❌ Test 2 FAILED: Second sandbox was not terminated within 10 minutes.");

      // Clean up if not terminated
      const finalStatus = await SandboxInstance.get(sandboxName);
      if (finalStatus.status === "RUNNING" || finalStatus.status === "DEPLOYED") {
        await SandboxInstance.delete(sandboxName);
        console.log("Cleaned up sandbox manually.");
      }
      process.exit(1);
    }

  } catch (e) {
    console.error("❌ There was an error => ", e);
    import('util').then(util => {
      console.error(util.inspect(e, { depth: null }));
    });
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error("❌ There was an error => ", err);
    process.exit(1);
  })
  .then(() => {
    process.exit(0);
  });
