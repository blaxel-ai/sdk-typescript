import { SandboxInstance } from "@blaxel/core"
import { bench, describe } from "vitest"
import { defaultImage, defaultLabels, uniqueName } from "./helpers"

describe("sandbox creation benchmark", () => {
  bench(
    "create sandbox",
    async () => {
      const name = uniqueName("bench-create")

      await SandboxInstance.create({
        name,
        image: defaultImage,
        labels: defaultLabels,
        memory: 2048,
      })

      // Delete immediately to free resources
      await SandboxInstance.delete(name).catch(() => {})
    },
    { iterations: 5, warmupIterations: 1 }
  )

  bench(
    "createIfNotExists sandbox",
    async () => {
      const name = uniqueName("bench-create-if")

      await SandboxInstance.createIfNotExists({
        name,
        image: defaultImage,
        labels: defaultLabels,
        memory: 2048,
      })

      // Delete immediately to free resources
      await SandboxInstance.delete(name).catch(() => {})
    },
    { iterations: 5, warmupIterations: 1 }
  )
})
