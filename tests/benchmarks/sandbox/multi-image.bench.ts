import { SandboxInstance } from "@blaxel/core"
import { bench, describe } from "vitest"
import { defaultLabels, uniqueName } from "./helpers.js"

const env = process.env.BL_ENV || "prod"
const defaultRegion = env === "dev" ? "eu-dub-1" : "us-pdx-1"

// Images to benchmark
const images = [
  'sandbox/minimal',
  'blaxel/base-image',
  'blaxel/expo',
  'blaxel/nextjs',
  'blaxel/node',
  'blaxel/py-app',
  'blaxel/ts-app',
  'blaxel/vite',
]

describe("multi-image sandbox benchmarks", () => {
  for (const image of images) {
    const imageName = image.split('/').pop() || image

    bench(
      `create + exec (ls /) + exec (echo) - ${imageName}`,
      async () => {
        const name = uniqueName(`bench-${imageName}`)

        try {
          // Create sandbox
          const sandbox = await SandboxInstance.create({
            name,
            image,
            region: defaultRegion,
            labels: defaultLabels,
          })

          // Execute ls /
          await sandbox.process.exec({ command: "ls /", waitForCompletion: true })

          // Execute echo
          await sandbox.process.exec({ command: "echo 'hello'", waitForCompletion: true })

          // Cleanup
          await SandboxInstance.delete(name).catch(() => {})
        } catch (error) {
          // Try to cleanup on error
          await SandboxInstance.delete(name).catch(() => {})
          throw error
        }
      },
      { iterations: 2, warmupIterations: 1 }
    )
  }

  bench(
    "parallel creation (5 base-image sandboxes)",
    async () => {
      const names = Array.from({ length: 5 }, () => uniqueName("bench-parallel"))

      try {
        const promises = names.map((name) =>
          SandboxInstance.create({
            name,
            image: "blaxel/base-image",
            region: defaultRegion,
            labels: defaultLabels,
          })
        )

        const sandboxes = await Promise.all(promises)

        // Execute a command on each
        await Promise.all(
          sandboxes.map((sandbox) =>
            sandbox.process.exec({ command: "echo 'test'", waitForCompletion: true })
          )
        )

        // Cleanup
        await Promise.all(names.map((name) => SandboxInstance.delete(name).catch(() => {})))
      } catch (error) {
        // Try to cleanup on error
        await Promise.all(names.map((name) => SandboxInstance.delete(name).catch(() => {})))
        throw error
      }
    },
    { iterations: 2, warmupIterations: 1 }
  )
})

