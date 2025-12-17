import { SandboxInstance } from "@blaxel/core";
import { bench, describe } from "vitest";

// ============ CONFIGURATION ============
const BATCH_SIZE = 10;
const BASE_NAME = "bench-mass-create";
// =======================================

// Store sandboxes created in the current iteration for cleanup
let iterationSandboxes: string[] = [];

describe("mass sandbox creation benchmark", () => {
  bench(
    `parallel batch creation (${BATCH_SIZE} sandboxes)`,
    async () => {
      const batchTasks = Array.from({ length: BATCH_SIZE }, async (_, index) => {
        const sandboxName = `${BASE_NAME}-${Date.now()}-${index}`;
        await SandboxInstance.createIfNotExists({
          name: sandboxName,
          image: "blaxel/base-image:latest",
        });
        iterationSandboxes.push(sandboxName);
        return sandboxName;
      });
      await Promise.allSettled(batchTasks);
    },
    {
      iterations: 5,
      warmupIterations: 0,
      time: 0,
      teardown: async () => {
        const toDelete = [...iterationSandboxes];
        iterationSandboxes = [];
        const deletePromises = toDelete.map(async (name) => {
          try {
            await SandboxInstance.delete(name);
          } catch {
            // Ignore cleanup errors
          }
        });
        await Promise.allSettled(deletePromises);
      },
    }
  );

  bench(
    "sequential creation",
    async () => {
      const sandboxName = `${BASE_NAME}-seq-${Date.now()}`;
      await SandboxInstance.createIfNotExists({
        name: sandboxName,
        image: "blaxel/base-image:latest",
      });
      iterationSandboxes.push(sandboxName);
    },
    {
      iterations: 5,
      warmupIterations: 0,
      time: 0,
      teardown: async () => {
        const toDelete = [...iterationSandboxes];
        iterationSandboxes = [];
        const deletePromises = toDelete.map(async (name) => {
          try {
            await SandboxInstance.delete(name);
          } catch {
            // Ignore cleanup errors
          }
        });
        await Promise.allSettled(deletePromises);
      },
    }
  );
});
