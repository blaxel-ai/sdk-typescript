import { SandboxCreateConfiguration, SandboxInstance } from "@blaxel/core";

async function main() {
  try {
    console.log("Test 1: Create default sandbox...");
    let sandbox = await SandboxInstance.create();
    await sandbox.wait();
    console.log(`✅ Created sandbox with default name: ${sandbox.metadata?.name}`);
    console.log(await sandbox.fs.ls('/blaxel'));
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("✅ Deleted default sandbox");

    console.log("\nTest 2: Create sandbox with spec containing runtime image...");
    sandbox = await SandboxInstance.create(
      { spec: { runtime: { image: "blaxel/prod-base:latest" } } }
    );
    await sandbox.wait();
    console.log(`✅ Created sandbox with spec: ${sandbox.metadata?.name}`);
    console.log(await sandbox.fs.ls('/blaxel'));
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("✅ Deleted spec sandbox");

    console.log("\nTest 3: Create sandbox with name...");
    sandbox = await SandboxInstance.create({ name: "sandbox-with-name" });
    await sandbox.wait();
    console.log(`✅ Created sandbox with name: ${sandbox.metadata?.name}`);
    console.log(await sandbox.fs.ls('/blaxel/'));
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("✅ Deleted named sandbox");

    console.log("\nTest 4: Create sandbox with SandboxCreateConfiguration...");
    const config: SandboxCreateConfiguration = {
      name: "sandbox-config",
      image: "blaxel/prod-base:latest",
      memory: 2048
    };
    sandbox = await SandboxInstance.create(config);
    await sandbox.wait();
    console.log(`✅ Created sandbox with config: ${sandbox.metadata?.name}`);
    console.log(await sandbox.fs.ls('/blaxel/'));
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("✅ Deleted config sandbox");

    console.log("\nTest 5: Create sandbox if not exists with name...");
    sandbox = await SandboxInstance.createIfNotExists({ name: "sandbox-cine-name" });
    await sandbox.wait();
    console.log(`✅ Created/found sandbox: ${sandbox.metadata?.name}`);
    console.log(await sandbox.fs.ls('/blaxel/'));
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("✅ Deleted create-if-not-exists sandbox");

    console.log("\nTest 6: Create sandbox if not exists with metadata...");
    sandbox = await SandboxInstance.createIfNotExists({ metadata: { name: "sandbox-cine-metadata" } });
    await sandbox.wait();
    console.log(`✅ Created/found sandbox with metadata: ${sandbox.metadata?.name}`);
    console.log(await sandbox.fs.ls('/blaxel/'));
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("✅ Deleted metadata sandbox");

    console.log("\nTest 7: Create sandbox with ports...");
    const portsConfig: SandboxCreateConfiguration = {
      name: "sandbox-with-ports",
      image: "blaxel/prod-base:latest",
      memory: 2048,
      ports: [
        { name: "web", target: 3000 }, // Will default to HTTP
        { name: "api", target: 8080, protocol: "TCP" },
      ],
    };
    sandbox = await SandboxInstance.create(portsConfig);
    await sandbox.wait();
    console.log(`✅ Created sandbox with ports: ${sandbox.metadata?.name}`);
    console.log(`   Image: ${sandbox.spec?.runtime?.image}`);
    console.log(`   Memory: ${sandbox.spec?.runtime?.memory}`);
    sandbox = await SandboxInstance.get(sandbox.metadata?.name!);
    if (sandbox.spec?.runtime?.ports) {
      console.log(`   Ports: ${sandbox.spec.runtime.ports.length} configured`);
      for (const port of sandbox.spec.runtime.ports) {
        console.log(`     - ${port.name}: ${port.target} (${port.protocol})`);
      }
    }
    console.log(await sandbox.fs.ls("/blaxel/"));
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("✅ Deleted ports sandbox");

    console.log("\n🎉 All sandbox creation tests passed!");
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
