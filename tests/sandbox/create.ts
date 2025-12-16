import { SandboxCreateConfiguration, SandboxInstance } from "@blaxel/core";
import assert from "assert";

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
      { spec: { runtime: { image: "blaxel/base-image:latest" } } }
    );
    console.log(`✅ Created sandbox with spec: ${sandbox.metadata?.name}`);
    console.log(await sandbox.fs.ls('/blaxel'));
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("✅ Deleted spec sandbox");

    console.log("\nTest 3: Create sandbox with name...");
    sandbox = await SandboxInstance.create({ name: "sandbox-with-name", labels: { "test": "test" } });
    console.log(`✅ Created sandbox with name: ${sandbox.metadata?.name}, labels: ${JSON.stringify(sandbox.metadata?.labels)}`);
    assert.strictEqual(sandbox.metadata?.labels?.["test"], "test");
    console.log(await sandbox.fs.ls('/blaxel/'));
    await SandboxInstance.delete(sandbox.metadata?.name!);
    console.log("✅ Deleted named sandbox");

    console.log("\nTest 4: Create sandbox with SandboxCreateConfiguration...");
    const config: SandboxCreateConfiguration = {
      name: "sandbox-config",
      image: "blaxel/base-image:latest",
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
      image: "blaxel/base-image:latest",
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
      image: "blaxel/base-image:latest",
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
      image: "blaxel/base-image:latest",
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

    // Test 10: Race condition test for createIfNotExists
    console.log("\nTest 10: Race condition test for createIfNotExists (5 concurrent calls)...");
    const raceSandboxName = "sandbox-race-condition-test";
    const concurrentCalls = 5;

    // Start 20 concurrent createIfNotExists calls with the same configuration
    const promises = Array.from({ length: concurrentCalls }, (_, i) =>
      SandboxInstance.createIfNotExists({ name: raceSandboxName })
        .then(sb => ({ index: i, sandbox: sb, error: null }))
        .catch(err => ({ index: i, sandbox: null, error: err }))
    );

    console.log(`   Starting ${concurrentCalls} concurrent createIfNotExists calls...`);
    const results = await Promise.all(promises);

    // Analyze results
    const successes = results.filter(r => r.sandbox !== null);
    const failures = results.filter(r => r.error !== null);

    console.log(`   Successes: ${successes.length}, Failures: ${failures.length}`);

    if (failures.length > 0) {
      console.log("   Failures:");
      for (const failure of failures) {
        console.log(`     - Call ${failure.index}: ${failure.error}`);
      }
    }

    // All successful calls should return the same sandbox name
    const uniqueNames = new Set(successes.map(r => r.sandbox?.metadata?.name));
    console.log(`   Unique sandbox names returned: ${uniqueNames.size}`);
    console.log(`   Sandbox names: ${Array.from(uniqueNames).join(', ')}`);

    if (uniqueNames.size !== 1) {
      await SandboxInstance.delete(raceSandboxName);
      throw new Error(`Race condition detected! Expected 1 unique sandbox name, got ${uniqueNames.size}`);
    }

    if (successes.length !== concurrentCalls) {
      await SandboxInstance.delete(raceSandboxName);
      throw new Error(`Expected all ${concurrentCalls} calls to succeed, but only ${successes.length} succeeded`);
    }

    console.log(`✅ All ${concurrentCalls} concurrent calls returned the same sandbox: ${Array.from(uniqueNames)[0]}`);

    // Cleanup
    await SandboxInstance.delete(raceSandboxName);
    console.log("✅ Deleted race condition test sandbox");

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
