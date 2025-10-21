import { SandboxCreateConfiguration, SandboxInstance } from "@blaxel/core";

async function main() {
  try {
    console.log("Test 1: Create default sandbox...");
    let sandbox = await SandboxInstance.create();
    console.log(`✅ Created sandbox with default name: ${sandbox.metadata?.name}`);
    console.log(await sandbox.fs.ls('/blaxel'));
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("✅ Deleted default sandbox");

    console.log("\nTest 2: Create sandbox with spec containing runtime image...");
    sandbox = await SandboxInstance.create(
      { spec: { runtime: { image: "blaxel/base:latest" } } }
    );
    console.log(`✅ Created sandbox with spec: ${sandbox.metadata?.name}`);
    console.log(await sandbox.fs.ls('/blaxel'));
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("✅ Deleted spec sandbox");

    console.log("\nTest 3: Create sandbox with name...");
    sandbox = await SandboxInstance.create({ name: "sandbox-with-name" });
    console.log(`✅ Created sandbox with name: ${sandbox.metadata?.name}`);
    console.log(await sandbox.fs.ls('/blaxel/'));
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("✅ Deleted named sandbox");

    console.log("\nTest 4: Create sandbox with SandboxCreateConfiguration...");
    const config: SandboxCreateConfiguration = {
      name: "sandbox-config",
      image: "blaxel/base:latest",
      memory: 2048
    };
    sandbox = await SandboxInstance.create(config);
    console.log(`✅ Created sandbox with config: ${sandbox.metadata?.name}`);
    console.log(await sandbox.fs.ls('/blaxel/'));
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("✅ Deleted config sandbox");

    console.log("\nTest 5: Create sandbox if not exists with name...");
    sandbox = await SandboxInstance.createIfNotExists({ name: "sandbox-cine-name" });
    console.log(`✅ Created/found sandbox: ${sandbox.metadata?.name}`);
    console.log(await sandbox.fs.ls('/blaxel/'));
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("✅ Deleted create-if-not-exists sandbox");

    console.log("\nTest 6: Create sandbox if not exists with metadata...");
    sandbox = await SandboxInstance.createIfNotExists({ metadata: { name: "sandbox-cine-metadata" } });
    console.log(`✅ Created/found sandbox with metadata: ${sandbox.metadata?.name}`);
    console.log(await sandbox.fs.ls('/blaxel/'));
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("✅ Deleted metadata sandbox");

    console.log("\nTest 7: Create sandbox with ports...");
    const portsConfig: SandboxCreateConfiguration = {
      name: "sandbox-with-ports",
      image: "blaxel/base:latest",
      memory: 2048,
      ports: [
        { name: "web", target: 3000 }, // Will default to HTTP
        { name: "api", target: 8080, protocol: "TCP" },
      ],
    };
    sandbox = await SandboxInstance.create(portsConfig);
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

    // Test 8: Create sandbox with environment variables
    console.log("\nTest 8: Create sandbox with environment variables...");
    const envsConfig: SandboxCreateConfiguration = {
      name: "sandbox-with-envs",
      image: "blaxel/base:latest",
      memory: 2048,
      envs: [
        { name: "NODE_ENV", value: "development" },
        { name: "DEBUG", value: "true" },
        { name: "API_KEY", value: "secret123" },
        { name: "PORT", value: "3000" },
      ],
    };
    sandbox = await SandboxInstance.create(envsConfig);
    console.log(`✅ Created sandbox with envs: ${sandbox.metadata?.name}`);
    console.log(`   Image: ${sandbox.spec?.runtime?.image}`);
    console.log(`   Memory: ${sandbox.spec?.runtime?.memory}`);
    sandbox = await SandboxInstance.get(sandbox.metadata?.name!);
    if (sandbox.spec?.runtime?.envs) {
      console.log(`   Envs: ${sandbox.spec.runtime.envs.length} configured`);
      for (const env of sandbox.spec.runtime.envs) {
        const envVar = env as { name: string; value: string };
        console.log(`     - ${envVar.name}: ${envVar.value}`);
      }
    }
    console.log(await sandbox.fs.ls("/blaxel/"));
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("✅ Deleted envs sandbox");

    // Test 9: Create sandbox with environment variables using dict syntax
    console.log("\nTest 9: Create sandbox with envs using dict syntax...");
    sandbox = await SandboxInstance.create({
      name: "sandbox-with-envs-dict",
      image: "blaxel/base:latest",
      memory: 2048,
      envs: [
        { name: "ENVIRONMENT", value: "test" },
        { name: "VERSION", value: "1.0.0" },
      ]
    });
    console.log(`✅ Created sandbox with envs dict: ${sandbox.metadata?.name}`);
    console.log(`   Image: ${sandbox.spec?.runtime?.image}`);
    console.log(`   Memory: ${sandbox.spec?.runtime?.memory}`);
    sandbox = await SandboxInstance.get(sandbox.metadata?.name!);
    if (sandbox.spec?.runtime?.envs) {
      console.log(`   Envs: ${sandbox.spec.runtime.envs.length} configured`);
      for (const env of sandbox.spec.runtime.envs) {
        const envVar = env as { name: string; value: string };
        console.log(`     - ${envVar.name}: ${envVar.value}`);
      }
    }
    console.log(await sandbox.fs.ls("/blaxel/"));
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("✅ Deleted envs dict sandbox");

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
