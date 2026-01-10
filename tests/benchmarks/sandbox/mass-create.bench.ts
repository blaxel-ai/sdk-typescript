import { SandboxInstance } from "@blaxel/core"
import { bench, describe } from "vitest"
import { defaultImage, defaultLabels, uniqueName } from "./helpers.js"

describe("mass sandbox creation benchmark", () => {
  bench(
    "parallel batch creation (10 sandboxes)",
    async () => {
      const batchSize = 10
      const names = Array.from({ length: batchSize }, () => uniqueName("bench-mass"))

      const promises = names.map((name) =>
        SandboxInstance.create({
          name,
          image: defaultImage,
          labels: defaultLabels,
          memory: 2048,
        })
      )

      await Promise.all(promises)

      // Delete them immediately to free resources
      const deletePromises = names.map((name) => SandboxInstance.delete(name).catch(() => {}))
      await Promise.all(deletePromises)
    },
    { iterations: 1, warmupIterations: 0 }
  )

  bench(
    "sequential creation",
    async () => {
      const names: string[] = []

      for (let i = 0; i < 10; i++) {
        const name = uniqueName("bench-seq")
        names.push(name)

        await SandboxInstance.create({
          name,
          image: defaultImage,
          labels: defaultLabels,
          memory: 2048,
        })

        // Delete immediately
        await SandboxInstance.delete(name).catch(() => {})
      }
    },
    { iterations: 1, warmupIterations: 0 }
  )
})
