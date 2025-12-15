import { SandboxInstance } from "@blaxel/core";

const BL_REGION = process.env.BL_REGION || (process.env.BL_ENV === "dev" ? "eu-dub-1" : "us-pdx-1");

async function waitForTermination(sandboxName: string, maxWaitTimeMs: number = 1200000): Promise<boolean> {
  const startTime = Date.now();
  const checkIntervalMs = 30000; // 30 seconds

  while (Date.now() - startTime < maxWaitTimeMs) {
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    console.log(`⏳ Checking sandbox status... (${elapsedSeconds}s elapsed)`);

    const sandboxStatus = await SandboxInstance.get(sandboxName);
    if (sandboxStatus.status === "TERMINATED") {
      console.log(`✅ Sandbox terminated after ${elapsedSeconds}s`);
      return true;
    }

    console.log(`   Current status: ${sandboxStatus.status}, waiting 30s before next check...`);
    await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
  }

  return false;
}

async function main() {
  try {
    const sandboxName = "sandbox-ttl-recreate-test";

    console.log("Test: Create sandbox with ttl, wait for termination, then recreate with same name...");
    console.log(`\n📦 Creating first sandbox with name: ${sandboxName}`);
    let sandbox = await SandboxInstance.create({ ttl: "60s", name: sandboxName, region: BL_REGION });
    await sandbox.wait();
    console.log(`✅ First sandbox created and ready: ${sandbox.metadata?.name}`);
    console.log(`   Sandbox status: ${sandbox.status}`);

    console.log(`\n⏳ Waiting for first sandbox to terminate...`);
    const terminated = await waitForTermination(sandboxName);
    if (!terminated) {
      console.log(`❌ First sandbox did not terminate within 20 minutes`);
      process.exit(1);
    }

    console.log(`\n📦 Creating second sandbox with the same name: ${sandboxName}`);
    const sandbox2 = await SandboxInstance.create({ ttl: "60s", name: sandboxName, region: BL_REGION });
    await sandbox2.wait();
    console.log(`✅ Second sandbox created and ready: ${sandbox2.metadata?.name}`);
    console.log(`   Sandbox status: ${sandbox2.status}`);
    console.log(`✅ SUCCESS: Second sandbox created with the same name after first one terminated`);

    console.log(`\n⏳ Waiting for second sandbox to terminate...`);
    const terminated2 = await waitForTermination(sandboxName);
    if (!terminated2) {
      console.log(`❌ Second sandbox did not terminate within 20 minutes`);
      process.exit(1);
    }

    console.log(`\n✅ Test completed successfully! Both sandboxes terminated as expected.`);
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

