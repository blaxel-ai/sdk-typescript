import { SandboxInstance } from "@blaxel/core"
import { bench, describe } from "vitest"
import { defaultImage, defaultLabels, uniqueName } from "./helpers.js"

// ============ CONFIGURATION ============
const REPO_URL = "https://github.com/relace-ai/vite-template.git"
const REPO_PATH = "/workspace/repo"
// =======================================

let sandbox: SandboxInstance | null = null
let setupDone = false

async function ensureSetup() {
  if (setupDone && sandbox) return sandbox

  const sandboxName = uniqueName("bench-process")
  console.log(`🔗 Creating sandbox: ${sandboxName}...`)
  sandbox = await SandboxInstance.create({
    name: sandboxName,
    image: defaultImage,
    labels: defaultLabels,
    memory: 4096,
  })
  console.log(`✓ Connected to sandbox: ${sandbox.metadata.name || "unknown"}`)

  // Setup test environment
  console.log("📦 Setting up test environment...")

  try {
    // Clone the vite-template repository
    console.log("  Cloning vite-template repository...")
    await sandbox.process.exec({
      command: `git clone ${REPO_URL} ${REPO_PATH}`,
      waitForCompletion: true,
    })
    console.log("✓ Test environment ready (repository cloned)")
  } catch (error) {
    console.log(
      `⚠️  Setup failed (may already exist): ${error instanceof Error ? error.message : String(error)}`
    )
  }

  setupDone = true
  return sandbox
}

describe("process vs native benchmark", () => {
  describe("fuzzy search", () => {
    bench(
      "fzf",
      async () => {
        const s = await ensureSetup()
        await s.process.exec({
          command: `find ${REPO_PATH}/ -type f | fzf -e -f "components.json"`,
          waitForCompletion: true,
        })
      },
      { iterations: 20, warmupIterations: 1 }
    )

    bench(
      "sandbox-search",
      async () => {
        const s = await ensureSetup()
        await s.fs.search("components.json", `${REPO_PATH}/`, {
          maxResults: 100,
          excludeHidden: false,
        })
      },
      { iterations: 20, warmupIterations: 1 }
    )
  })

  describe("find files", () => {
    bench(
      "find-bash",
      async () => {
        const s = await ensureSetup()
        await s.process.exec({
          command: `find ${REPO_PATH}/ -type f -name "*.json" | head -100`,
          waitForCompletion: true,
        })
      },
      { iterations: 20, warmupIterations: 1 }
    )

    bench(
      "sandbox-find",
      async () => {
        const s = await ensureSetup()
        await s.fs.find(`${REPO_PATH}/`, {
          type: "file",
          patterns: ["*.json"],
          maxResults: 100,
          excludeHidden: true,
        })
      },
      { iterations: 20, warmupIterations: 1 }
    )
  })
})
