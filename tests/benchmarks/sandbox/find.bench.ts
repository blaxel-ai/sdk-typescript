import { SandboxInstance } from "@blaxel/core"
import { bench, describe } from "vitest"
import { defaultImage, defaultLabels, uniqueName } from "./helpers"

// ============ CONFIGURATION ============
const REPO_URL = "https://github.com/vercel/next.js.git"
const REPO_PATH = "/workspace/nextjs-repo"
// =======================================

let sandbox: SandboxInstance | null = null
let setupDone = false

async function ensureSetup() {
  if (setupDone && sandbox) return sandbox

  const sandboxName = uniqueName("bench-find")
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
    // Install fd
    console.log(`   Installing fd...`)
    await sandbox.process.exec({
      command: `curl -L https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-x86_64-unknown-linux-musl.tar.gz | tar xz && mv fd-v10.2.0-x86_64-unknown-linux-musl/fd /usr/local/bin/fd`,
      waitForCompletion: true,
    })

    // Clone repo if not exists
    console.log(`   Cloning ${REPO_URL}...`)
    await sandbox.process.exec({
      command: `git clone --depth 1 ${REPO_URL} ${REPO_PATH}`,
      waitForCompletion: true,
    })

    // Run npm install
    console.log(`   Running npm install...`)
    await sandbox.process.exec({
      command: `cd ${REPO_PATH} && npm install`,
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

describe("find benchmark", () => {
  bench(
    "find-bash",
    async () => {
      const s = await ensureSetup()
      await s.process.exec({
        command: `find ${REPO_PATH} -type f \\( -name "*.json" -o -name "*.html" \\) | head -1000`,
        waitForCompletion: true,
      })
    },
    { iterations: 20, warmupIterations: 1 }
  )

  bench(
    "fd",
    async () => {
      const s = await ensureSetup()
      await s.process.exec({
        command: `fd -t f -e json -e html . ${REPO_PATH} | head -1000`,
        waitForCompletion: true,
      })
    },
    { iterations: 20, warmupIterations: 1 }
  )

  bench(
    "sandbox-find",
    async () => {
      const s = await ensureSetup()
      await s.fs.find(REPO_PATH, {
        type: "file",
        patterns: ["*.json", "*.html"],
        maxResults: 1000,
      })
    },
    { iterations: 20, warmupIterations: 1 }
  )
})
