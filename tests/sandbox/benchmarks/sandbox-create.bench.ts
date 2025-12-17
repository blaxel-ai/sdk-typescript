import { SandboxInstance } from "@blaxel/core";
import { bench, describe, afterAll } from "vitest";

// ============ CONFIGURATION ============
const BASE_SANDBOX_NAME = "bench-create";
// =======================================

const createdSandboxes: string[] = [];

describe("sandbox creation benchmark", () => {
  afterAll(async () => {
    console.log(`\n🗑️  Cleaning up ${createdSandboxes.length} sandboxes...`);
    const deletePromises = createdSandboxes.map(async (name) => {
      try {
        await SandboxInstance.delete(name);
      } catch {
        // Ignore cleanup errors
      }
    });
    await Promise.allSettled(deletePromises);
    console.log(`✓ Cleanup complete`);
  });

  bench(
    "create sandbox",
    async () => {
      const sandboxName = `${BASE_SANDBOX_NAME}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      await SandboxInstance.create({
        name: sandboxName,
        image: "blaxel/base-image:latest",
        memory: 4096,
      });
      createdSandboxes.push(sandboxName);
    },
    { iterations: 5, warmupIterations: 1, time: 0 }
  );

  bench(
    "createIfNotExists sandbox",
    async () => {
      const sandboxName = `${BASE_SANDBOX_NAME}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      await SandboxInstance.createIfNotExists({
        name: sandboxName,
        image: "blaxel/base-image:latest",
        memory: 4096,
      });
      createdSandboxes.push(sandboxName);
    },
    { iterations: 5, warmupIterations: 1, time: 0 }
  );
});
