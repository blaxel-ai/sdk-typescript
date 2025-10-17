import { SandboxInstance } from "@blaxel/core";

async function main() {
  try {
    console.log("Test: Create sandbox with ttl-idle expiration policy...");

    // Create sandbox with ttl-idle expiration policy of 20 seconds
    const sandbox = await SandboxInstance.create({
      name: "sandbox-ttl-idle",
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
    const execResult = await sandbox.process.exec({ command: "echo 'activate idle timer'" });
    console.log(`Process exec successful (pid: ${execResult.pid}) - Idle timer activated`);

    // Wait for 2 minutes (600 seconds) to allow the idle timeout to trigger
    console.log("Waiting for 10 minutes to check if sandbox terminates due to idle timeout...");
    await new Promise(resolve => setTimeout(resolve, 600000));

    // Check sandbox status
    const sandboxStatus = await SandboxInstance.get(sandbox.metadata?.name!);

    if (sandboxStatus.status === "TERMINATED" || sandboxStatus.status === "DELETED") {
      console.log(`✅ Success! Sandbox status: ${sandboxStatus.status}`);
      console.log("✅ The sandbox was terminated after 20 seconds of idle time as expected.");
    } else {
      console.log(`❌ Failed! Sandbox status: ${sandboxStatus.status}`);
      console.log("❌ The sandbox should have been terminated after 20 seconds of idle time.");

      // Clean up if not terminated
      if (sandboxStatus.status === "RUNNING") {
        await SandboxInstance.delete(sandbox.metadata?.name!);
        console.log("Cleaned up sandbox manually.");
      }
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
