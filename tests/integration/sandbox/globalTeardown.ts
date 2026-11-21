import { SandboxInstance, VolumeInstance } from "@blaxel/core"
import { belongsToTestRun, deleteTestSandbox } from "./cleanup.js"

/**
 * Global setup - returns a teardown function that runs after ALL tests complete
 * This cleans up only sandboxes/volumes owned by this test run
 */
export default function globalSetup() {
  const runId = process.env.BL_TEST_RUN_ID
  const belongsToRun = (labels: Record<string, string>) => belongsToTestRun(labels, runId)
  // Return the teardown function
  return async () => {
    if (process.env.SKIP_CLEANUP === "1") {
      console.log("\nSKIP_CLEANUP=1: skipping global cleanup, test resources are left alive for debugging")
      return
    }
    if (!runId) {
      console.log("No BL_TEST_RUN_ID: skipping global cleanup to avoid deleting another run’s resources")
      return
    }
    console.log("\n🧹 Cleaning up test resources...")

    // Clean up sandboxes with test labels
    try {
      const sandboxes = await (await SandboxInstance.list({ showTerminated: true })).autoPagingToArray({ limit: 10000 })
      for (const sb of sandboxes) {
        const labels = sb.metadata.labels || {}
        if (belongsToRun(labels)) {
          try {
            if (sb.metadata.name) await deleteTestSandbox(sb.metadata.name, runId)
          } catch (error) {
            console.log(`  Error cleaning sandbox ${sb.metadata.name}:`, error)
          }
        }
      }
    } catch (e) {
      console.log(`  Error listing sandboxes: ${String(e)}`)
    }

    // Clean up volumes with test labels
    try {
      const volumes = await (await VolumeInstance.list()).autoPagingToArray({ limit: 10000 })
      for (const vol of volumes) {
        const labels = vol.metadata.labels || {}
        if (belongsToRun(labels)) {
          try {
            if (vol.name) await VolumeInstance.delete(vol.name)
          } catch {
            // Ignore deletion errors
          }
        }
      }
    } catch (e) {
      console.log(`  Error listing volumes: ${String(e)}`)
    }

    console.log("✅ Cleanup complete!")
  }
}
