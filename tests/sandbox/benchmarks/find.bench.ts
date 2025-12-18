import { SandboxInstance } from "@blaxel/core";
import { bench, describe, beforeAll, afterAll } from "vitest";

// ============ CONFIGURATION ============
const SANDBOX_NAME = "bench-find";
const REPO_URL = "https://github.com/vercel/next.js.git";
const REPO_PATH = "/workspace/nextjs-repo";
// =======================================

let sandbox: SandboxInstance;

describe("find benchmark", () => {
  beforeAll(async () => {
    console.log(`🔗 Connecting to sandbox: ${SANDBOX_NAME}...`);
    sandbox = await SandboxInstance.get(SANDBOX_NAME);
    console.log(`✓ Connected`);

    // Setup environment
    console.log(`📦 Setting up environment...`);

    try {
      // Install fd
      console.log(`   Installing fd...`);
      await sandbox.process.exec({
        command: `curl -L https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-x86_64-unknown-linux-musl.tar.gz | tar xz && mv fd-v10.2.0-x86_64-unknown-linux-musl/fd /usr/local/bin/fd`,
        waitForCompletion: true,
      });

      // Clone repo if not exists
      console.log(`   Cloning ${REPO_URL}...`);
      await sandbox.process.exec({
        command: `git clone --depth 1 ${REPO_URL} ${REPO_PATH}`,
        waitForCompletion: true,
      });

      // Run npm install
      console.log(`   Running npm install...`);
      await sandbox.process.exec({
        command: `cd ${REPO_PATH} && npm install`,
        waitForCompletion: true,
      });

      console.log(`✓ Environment ready`);
    } catch (error) {
      console.log(
        `⚠️  Setup failed (may already exist): ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Validation
    console.log("\n🔍 Validation...");

    const bashValidation = await sandbox.process.exec({
      command: `find ${REPO_PATH} -type f \\( -name "*.json" -o -name "*.html" \\) | head -100 | wc -l`,
      waitForCompletion: true,
    });
    const bashCount = parseInt((bashValidation.logs || "").trim()) || 0;
    console.log(`   find-bash: ${bashCount} files`);

    const fdValidation = await sandbox.process.exec({
      command: `fd -t f -e json -e html . ${REPO_PATH} | head -100 | wc -l`,
      waitForCompletion: true,
    });
    const fdCount = parseInt((fdValidation.logs || "").trim()) || 0;
    console.log(`   fd:        ${fdCount} files`);

    const nativeValidation = await sandbox.fs.find(REPO_PATH, {
      type: "file",
      patterns: ["*.json", "*.html"],
      maxResults: 100,
      excludeHidden: true,
    });
    console.log(`   native:    ${nativeValidation.matches?.length || 0} matches`);
  }, 600000); // 10 min timeout for setup

  afterAll(() => {
    console.log(`\n💾 Sandbox '${SANDBOX_NAME}' remains available.`);
  });

  bench(
    "find-bash",
    async () => {
      await sandbox.process.exec({
        command: `find ${REPO_PATH} -type f \\( -name "*.json" -o -name "*.html" \\) | head -1000`,
        waitForCompletion: true,
      });
    },
    { iterations: 20, warmupIterations: 3, time: 0 }
  );

  bench(
    "fd",
    async () => {
      await sandbox.process.exec({
        command: `fd -t f -e json -e html . ${REPO_PATH} | head -1000`,
        waitForCompletion: true,
      });
    },
    { iterations: 20, warmupIterations: 3, time: 0 }
  );

  bench(
    "native-find",
    async () => {
      await sandbox.fs.find(REPO_PATH, {
        type: "file",
        patterns: ["*.json", "*.html"],
        maxResults: 1000,
      });
    },
    { iterations: 20, warmupIterations: 3, time: 0 }
  );
});
