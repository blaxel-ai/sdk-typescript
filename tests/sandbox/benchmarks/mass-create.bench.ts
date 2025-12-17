import { SandboxInstance } from "@blaxel/core";
import { bench, describe, afterAll } from "vitest";

// ============ CONFIGURATION ============
const BATCH_SIZE = 10;
const BASE_NAME = "bench-mass-create";
// =======================================

const createdSandboxes: string[] = [];

async function createSandbox(index: number): Promise<string> {
  const sandboxName = `${BASE_NAME}-${Date.now()}-${index}`;
  await SandboxInstance.createIfNotExists({
    name: sandboxName,
    image: "blaxel/base-image:latest",
  });
  createdSandboxes.push(sandboxName);
  return sandboxName;
}

describe("mass sandbox creation benchmark", () => {
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
    `parallel batch creation (${BATCH_SIZE} sandboxes)`,
    async () => {
      const batchTasks = Array.from({ length: BATCH_SIZE }, (_, index) =>
        createSandbox(index)
      );
      await Promise.allSettled(batchTasks);
    },
    { iterations: 5, warmupIterations: 1, time: 0 }
  );

  bench(
    "sequential creation",
    async () => {
      const sandboxName = `${BASE_NAME}-seq-${Date.now()}`;
      await SandboxInstance.createIfNotExists({
        name: sandboxName,
        image: "blaxel/base-image:latest",
      });
      createdSandboxes.push(sandboxName);
    },
    { iterations: 5, warmupIterations: 1, time: 0 }
  );
});
