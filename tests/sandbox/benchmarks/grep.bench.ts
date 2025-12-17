import { SandboxInstance } from "@blaxel/core";
import { bench, describe, beforeAll, afterAll } from "vitest";

// ============ CONFIGURATION ============
const SANDBOX_NAME = "bench-grep";
const REPO_URL = "https://github.com/relace-ai/vite-template.git";
const REPO_PATH = "/workspace/vite-grep";
const SEARCH_TERM = "script";
// =======================================

let sandbox: SandboxInstance;

describe("grep benchmark", () => {
  beforeAll(async () => {
    console.log(`🔗 Connecting to sandbox: ${SANDBOX_NAME}...`);
    sandbox = await SandboxInstance.get(SANDBOX_NAME);
    console.log(`✓ Connected`);

    // Setup environment
    console.log(`📦 Setting up environment...`);

    try {
      // Install ripgrep
      console.log(`   Installing ripgrep...`);
      await sandbox.process.exec({
        command: `apk add ripgrep`,
        waitForCompletion: true,
      });

      // Clone repo
      console.log(`   Cloning ${REPO_URL}...`);
      await sandbox.process.exec({
        command: `git clone ${REPO_URL} ${REPO_PATH}`,
        waitForCompletion: true,
      });

      console.log(`✓ Environment ready`);
    } catch (error) {
      console.log(
        `⚠️  Setup failed (may already exist): ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Validation
    console.log("🔍 Validation...");

    const bashVal = await sandbox.process.exec({
      command: `grep -r "${SEARCH_TERM}" ${REPO_PATH} 2>/dev/null | head -10`,
      waitForCompletion: true,
    });
    const bashLines = (bashVal.logs || "").trim().split("\n").filter((l) => l);
    console.log(`   grep-bash:    ${bashLines.length} matches`);

    const rgVal = await sandbox.process.exec({
      command: `rg "${SEARCH_TERM}" ${REPO_PATH} | head -10`,
      waitForCompletion: true,
    });
    const rgLines = (rgVal.logs || "").trim().split("\n").filter((l) => l);
    console.log(`   ripgrep:      ${rgLines.length} matches`);

    const nativeVal = await sandbox.fs.grep(SEARCH_TERM, REPO_PATH, {
      maxResults: 10,
    });
    console.log(`   native-grep:  ${nativeVal.matches?.length || 0} matches`);
  }, 300000); // 5 min timeout for setup

  afterAll(() => {
    console.log(`\n💾 Sandbox '${SANDBOX_NAME}' remains available.`);
  });

  bench(
    "grep-bash",
    async () => {
      await sandbox.process.exec({
        command: `grep -r "${SEARCH_TERM}" ${REPO_PATH} 2>/dev/null | head -100`,
        waitForCompletion: true,
      });
    },
    { iterations: 20, warmupIterations: 3, time: 0 }
  );

  bench(
    "ripgrep",
    async () => {
      await sandbox.process.exec({
        command: `rg "${SEARCH_TERM}" ${REPO_PATH} | head -100`,
        waitForCompletion: true,
      });
    },
    { iterations: 20, warmupIterations: 3, time: 0 }
  );

  bench(
    "native-grep",
    async () => {
      await sandbox.fs.grep(SEARCH_TERM, REPO_PATH, {
        maxResults: 100,
      });
    },
    { iterations: 20, warmupIterations: 3, time: 0 }
  );
});
