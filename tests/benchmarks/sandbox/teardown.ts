import { SandboxInstance } from "@blaxel/core"

export default function globalSetup() {
  const runId = process.env.BL_TEST_RUN_ID
  // Return the teardown function
  return async () => {
    if (process.env.SKIP_CLEANUP === "1") {
      console.log("SKIP_CLEANUP=1. Skipping benchmark cleanup.")
      return
    }
    if (!runId) {
      console.log("No BL_TEST_RUN_ID. Skipping benchmark cleanup.")
      return
    }

    console.log("\n🧹 Global cleanup: looking for benchmark sandboxes...")

    try {
      const sandboxes = await (await SandboxInstance.list()).autoPagingToArray({ limit: 10000 })
      const benchSandboxes = sandboxes.filter(
        (s) =>
          s.metadata.labels?.env === "benchmark" &&
          s.metadata.labels?.language === "typescript" &&
          s.metadata.labels?.["created-by"] === "vitest-bench" &&
          s.metadata.labels?.["test-run-id"] === runId
      )

      if (benchSandboxes.length === 0) {
        console.log("✓ No benchmark sandboxes to clean up")
        return
      }

      console.log(`   Found ${benchSandboxes.length} benchmark sandbox(es) to clean up`)

      const deletePromises = benchSandboxes.map(async (s) => {
        const name = s.metadata.name
        if (name) {
          try {
            await SandboxInstance.delete(name)
            console.log(`   ✓ Deleted ${name}`)
          } catch (error) {
            console.log(`   ⚠️  Failed to delete ${name}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      })

      await Promise.all(deletePromises)
      console.log("✓ Cleanup complete")
    } catch (error) {
      console.log(`⚠️  Cleanup error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
