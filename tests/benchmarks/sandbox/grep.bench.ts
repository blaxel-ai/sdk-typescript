import { SandboxInstance } from "@blaxel/core"
import { bench, describe } from "vitest"
import { defaultImage, defaultLabels, uniqueName } from "./helpers.js"

// ============ CONFIGURATION ============
const REPO_URL = "https://github.com/relace-ai/vite-template.git"
const REPO_PATH = "/workspace/vite-grep"
const SEARCH_TERM = "script"
// =======================================

let sandbox: SandboxInstance | null = null
let setupDone = false

async function ensureSetup() {
  if (setupDone && sandbox) return sandbox

  const sandboxName = uniqueName("bench-grep")
  console.log(`🔗 Creating sandbox: ${sandboxName}...`)
  sandbox = await SandboxInstance.create({
    name: sandboxName,
    image: defaultImage,
    labels: defaultLabels,
    memory: 4096,
  })
  console.log(`✓ Connected`)

  // Setup environment
  console.log(`📦 Setting up environment...`)

  try {
    // Install ripgrep
    console.log(`   Installing ripgrep...`)
    await sandbox.process.exec({
      command: `apk add ripgrep`,
      waitForCompletion: true,
    })

    // Clone repo
    console.log(`   Cloning ${REPO_URL}...`)
    await sandbox.process.exec({
      command: `git clone ${REPO_URL} ${REPO_PATH}`,
      waitForCompletion: true,
    })

    console.log(`✓ Environment ready`)
  } catch (error) {
    console.log(
      `⚠️  Setup failed (may already exist): ${error instanceof Error ? error.message : String(error)}`
    )
  }

  setupDone = true
  return sandbox
}

describe("grep benchmark", () => {
  bench(
    "grep-bash",
    async () => {
      const s = await ensureSetup()
      await s.process.exec({
        command: `grep -r "${SEARCH_TERM}" ${REPO_PATH} 2>/dev/null | head -100`,
        waitForCompletion: true,
      })
    },
    { iterations: 20, warmupIterations: 1 }
  )

  bench(
    "ripgrep",
    async () => {
      const s = await ensureSetup()
      await s.process.exec({
        command: `rg "${SEARCH_TERM}" ${REPO_PATH} | head -100`,
        waitForCompletion: true,
      })
    },
    { iterations: 20, warmupIterations: 1 }
  )

  bench(
    "sandbox-grep",
    async () => {
      const s = await ensureSetup()
      await s.fs.grep(SEARCH_TERM, REPO_PATH, {
        maxResults: 100,
      })
    },
    { iterations: 20, warmupIterations: 1 }
  )
})
