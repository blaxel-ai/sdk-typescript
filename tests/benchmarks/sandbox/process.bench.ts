import { SandboxInstance } from "@blaxel/core"
import { bench, describe } from "vitest"
import { defaultImage, defaultLabels, uniqueName } from "./helpers.js"

let sandbox: SandboxInstance | null = null
let setupDone = false
const ITERATIONS = 100
const WARMUP_ITERATIONS = 2

async function ensureSetup() {
  if (setupDone && sandbox) return sandbox

  const sandboxName = uniqueName("bench-exec")
  console.log(`🔗 Creating sandbox: ${sandboxName}...`)
  sandbox = await SandboxInstance.create({
    name: sandboxName,
    image: defaultImage,
    labels: defaultLabels,
    memory: 2048,
  })
  console.log(`✓ Connected to sandbox: ${sandbox.metadata.name || "unknown"}`)
  setupDone = true
  return sandbox
}

describe("process exec benchmark", () => {
  describe("waitForCompletion methods", () => {
    bench(
      "waitForCompletion: true with callbacks",
      async () => {
        const s = await ensureSetup()
        const logs: string[] = []
        const stdout: string[] = []
        const stderr: string[] = []
        await s.process.exec({
          command: "echo 'hello world'",
          waitForCompletion: true,
          onLog: (log) => logs.push(log),
          onStdout: (line) => stdout.push(line),
          onStderr: (line) => stderr.push(line),
        })
      },
      { iterations: ITERATIONS, warmupIterations: WARMUP_ITERATIONS }
    )

    bench(
      "waitForCompletion: false + process.wait",
      async () => {
        const s = await ensureSetup()
        const proc = await s.process.exec({
          command: "echo 'hello world'",
          waitForCompletion: false,
        })
        await s.process.wait(proc.pid, { maxWait: 5000, interval: 50 })
      },
      { iterations: ITERATIONS, warmupIterations: WARMUP_ITERATIONS }
    )

    bench(
      "waitForCompletion: true (no callbacks)",
      async () => {
        const s = await ensureSetup()
        await s.process.exec({
          command: "echo 'hello world'",
          waitForCompletion: true,
        })
      },
      { iterations: ITERATIONS, warmupIterations: WARMUP_ITERATIONS }
    )
  })
})
