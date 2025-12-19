import { SandboxInstance } from "@blaxel/core";
import { bench, describe } from "vitest";

// ============ CONFIGURATION ============
const BASE_SANDBOX_NAME = "bench-create";
// =======================================

// Store the last created sandbox name for cleanup in teardown
let lastCreatedSandbox: string | null = null;

describe("sandbox creation benchmark", () => {
  bench(
    "create sandbox",
    async () => {
      const sandboxName = `${BASE_SANDBOX_NAME}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      await SandboxInstance.create({
        name: sandboxName,
        image: "blaxel/base-image:latest",
        memory: 4096,
      });
      lastCreatedSandbox = sandboxName;
    },
    {
      iterations: 10,
      warmupIterations: 0,
      time: 0,
      teardown: async () => {
        if (lastCreatedSandbox) {
          try {
            await SandboxInstance.delete(lastCreatedSandbox);
          } catch {
            // Ignore cleanup errors
          }
          lastCreatedSandbox = null;
        }
      },
    }
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
      lastCreatedSandbox = sandboxName;
    },
    {
      iterations: 10,
      warmupIterations: 0,
      time: 0,
      teardown: async () => {
        if (lastCreatedSandbox) {
          try {
            await SandboxInstance.delete(lastCreatedSandbox);
          } catch {
            // Ignore cleanup errors
          }
          lastCreatedSandbox = null;
        }
      },
    }
  );
});
