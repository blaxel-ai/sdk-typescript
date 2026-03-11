import { SandboxInstance } from "@blaxel/core"
import { bench, describe } from "vitest"
import { defaultImage, defaultLabels, uniqueName } from "./helpers.js"

const ITERATIONS = 10
const WARMUP_ITERATIONS = 1

describe("cold-call benchmark (create → call → delete)", () => {
  bench(
    "create → fs.ls('/') → delete",
    async () => {
      const name = uniqueName("bench-cold-ls")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        labels: defaultLabels,
        memory: 2048,
      })

      await sandbox.fs.ls("/")

      await SandboxInstance.delete(name).catch(() => {})
    },
    { iterations: ITERATIONS, warmupIterations: WARMUP_ITERATIONS }
  )

  bench(
    "create → process.exec('echo ok') → delete",
    async () => {
      const name = uniqueName("bench-cold-exec")
      const sandbox = await SandboxInstance.create({
        name,
        image: defaultImage,
        labels: defaultLabels,
        memory: 2048,
      })

      await sandbox.process.exec({
        command: "echo ok",
        waitForCompletion: true,
      })

      await SandboxInstance.delete(name).catch(() => {})
    },
    { iterations: ITERATIONS, warmupIterations: WARMUP_ITERATIONS }
  )
})
