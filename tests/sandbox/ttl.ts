import { SandboxInstance } from "@blaxel/core";

async function main() {
  try {
    console.log("Test 1: Create sandbox with ttl...");
    let sandbox = await SandboxInstance.create({ ttl: "60s", name: "sandbox-ttl", image: "blaxel/dev-base:latest" });
    await sandbox.wait();
    console.log(`✅ Created sandbox with default name: ${sandbox.metadata?.name}`);
    await new Promise(resolve => setTimeout(resolve, 120000));
    let sandboxStatus = await SandboxInstance.get(sandbox.metadata?.name!)
    if (sandboxStatus.status === "TERMINATED") {
      console.log(`✅ Sandbox status: ${sandboxStatus.status}`);
    } else {
      console.log(`❌ Sandbox status: ${sandboxStatus.status}`);
    }


    // console.log("Test 2: Create sandbox with expiresAt...");
    // let date = new Date();
    // date.setSeconds(date.getSeconds() + 60);
    // sandbox = await SandboxInstance.create({ expires: date, name: "sandbox-expires" });
    // await sandbox.wait();
    // console.log(`✅ Created sandbox with default name: ${sandbox.metadata?.name}`);
    // await new Promise(resolve => setTimeout(resolve, 120000));
    // sandboxStatus = await SandboxInstance.get(sandbox.metadata?.name!)
    // if (sandboxStatus.status === "TERMINATED") {
    //   console.log(`✅ Sandbox status: ${sandboxStatus.status}`);
    // } else {
    //   console.log(`❌ Sandbox status: ${sandboxStatus.status}`);
    // }
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
