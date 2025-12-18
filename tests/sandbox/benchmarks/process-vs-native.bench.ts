import { SandboxInstance } from "@blaxel/core";
import { bench, describe, beforeAll, afterAll } from "vitest";

// ============ CONFIGURATION ============
const SANDBOX_NAME = "bench-process-vs-native";
// =======================================

let sandbox: SandboxInstance;

describe("process vs native benchmark", () => {
  beforeAll(async () => {
    console.log(`🔗 Connecting to sandbox: ${SANDBOX_NAME}...`);
    sandbox = await SandboxInstance.get(SANDBOX_NAME);
    console.log(`✓ Connected to sandbox: ${sandbox.metadata?.name || "unknown"}`);

    // Setup test environment
    console.log("📦 Setting up test environment...");

    try {
      // Clone the vite-template repository
      console.log("  Cloning vite-template repository...");
      await sandbox.process.exec({
        command: "git clone https://github.com/relace-ai/vite-template.git /workspace/repo",
      });
      console.log("✓ Test environment ready (repository cloned)");
    } catch (error) {
      console.log(
        `⚠️  Setup failed (may already exist): ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Validate FUZZY SEARCH
    console.log("\n🔍 Validating FUZZY SEARCH (components.json)...");
    try {
      const fzfResult = await sandbox.process.exec({
        command: 'find /workspace/repo/ -type f | fzf -e -f "components.json"',
        waitForCompletion: true,
      });
      const fzfLines = (fzfResult.logs || "").trim().split("\n").filter((l) => l);
      console.log(`   fzf:           Found ${fzfLines.length} files`);

      const nativeSearchResult = await sandbox.fs.search("", "/workspace/repo", {
        patterns: ["*.json"],
        maxResults: 100,
        excludeHidden: false,
      });
      console.log(`   native-search: Found ${nativeSearchResult.matches?.length || 0} files`);
    } catch (error) {
      console.log(`   ⚠️  Validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Validate FIND
    console.log("\n🔍 Validating FIND (*.json from /)...");
    try {
      const findBashResult = await sandbox.process.exec({
        command: 'find /workspace/repo/ -type f -name "*.json" | head -100',
        waitForCompletion: true,
      });
      const bashLines = (findBashResult.logs || "").trim().split("\n").filter((l) => l);
      console.log(`   find-bash:   Found ${bashLines.length} files`);

      const findNativeResult = await sandbox.fs.find("/workspace/repo/", {
        type: "file",
        patterns: ["*.json"],
        maxResults: 100,
        excludeHidden: true,
      });
      console.log(`   native-find: Found ${findNativeResult.matches?.length || 0} matches`);
    } catch (error) {
      console.log(`   ⚠️  Validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 300000); // 5 min timeout for setup

  afterAll(() => {
    console.log(`\n💾 Sandbox '${SANDBOX_NAME}' remains available for further testing.`);
  });

  describe("fuzzy search", () => {
    bench(
      "fzf",
      async () => {
        await sandbox.process.exec({
          command: 'find /workspace/repo/ -type f | fzf -e -f "components.json"',
          waitForCompletion: true,
        });
      },
      { iterations: 20, warmupIterations: 3, time: 0 }
    );

    bench(
      "native-search",
      async () => {
        await sandbox.fs.search("components.json", "/workspace/repo/", {
          maxResults: 100,
          excludeHidden: false,
        });
      },
      { iterations: 20, warmupIterations: 3, time: 0 }
    );
  });

  describe("find files", () => {
    bench(
      "find-bash",
      async () => {
        await sandbox.process.exec({
          command: 'find /workspace/repo/ -type f -name "*.json" | head -100',
          waitForCompletion: true,
        });
      },
      { iterations: 20, warmupIterations: 3, time: 0 }
    );

    bench(
      "native-find",
      async () => {
        await sandbox.fs.find("/workspace/repo/", {
          type: "file",
          patterns: ["*.json"],
          maxResults: 100,
          excludeHidden: true,
        });
      },
      { iterations: 20, warmupIterations: 3, time: 0 }
    );
  });
});
