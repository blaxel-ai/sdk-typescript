import { SandboxInstance, VolumeInstance } from "@blaxel/core"

/**
 * Global setup - returns a teardown function that runs after ALL tests complete
 * This cleans up any sandboxes/volumes with test labels
 */
export default function globalSetup() {
  // Return the teardown function
  return async () => {
    if (process.env.SKIP_CLEANUP === "1") {
      console.log("\nSKIP_CLEANUP=1: skipping global cleanup, test resources are left alive for debugging")
      return
    }
    console.log("\n🧹 Cleaning up test resources...")

    // Clean up sandboxes with test labels
    try {
      const sandboxes = await (await SandboxInstance.list()).autoPagingToArray({ limit: 10000 })
      for (const sb of sandboxes) {
        if (sb.status === "TERMINATED") {
          continue
        }
        const labels = sb.metadata.labels || {}
        if (labels["env"] === "integration-test") {
          try {
            if (sb.metadata.name) await SandboxInstance.delete(sb.metadata.name)
          } catch {
            // Ignore deletion errors
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
        if (labels["env"] === "integration-test") {
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
