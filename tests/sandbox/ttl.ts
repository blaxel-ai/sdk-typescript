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
    console.log("Test 1: Create sandbox with ttl...");
    let sandbox = await SandboxInstance.create({ ttl: "60s", name: "sandbox-ttl", region: BL_REGION });
    await sandbox.wait();
    console.log(`✅ Created sandbox with default name: ${sandbox.metadata?.name}`);

    const terminated = await waitForTermination(sandbox.metadata?.name!);
    if (!terminated) {
      console.log(`❌ Sandbox did not terminate within 20 minutes`);
    }


    console.log("Test 2: Create sandbox with expiresAt...");
    let date = new Date();
    date.setSeconds(date.getSeconds() + 60);
    sandbox = await SandboxInstance.create({ expires: date, name: "sandbox-expires", region: BL_REGION });
    await sandbox.wait();
    console.log(`✅ Created sandbox with default name: ${sandbox.metadata?.name}`);

    const terminated2 = await waitForTermination(sandbox.metadata?.name!);
    if (!terminated2) {
      console.log(`❌ Sandbox did not terminate within 20 minutes`);
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
