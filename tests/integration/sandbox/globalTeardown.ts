import { SandboxInstance, VolumeInstance } from "@blaxel/core"

/**
 * Global setup - returns a teardown function that runs after ALL tests complete
 * This cleans up any sandboxes/volumes with test labels
 */
export default function globalSetup() {
  // Return the teardown function
  return async () => {
    console.log("\n🧹 Cleaning up test resources...")

    // Clean up sandboxes with test labels
    try {
      const sandboxes = await SandboxInstance.list()
      for (const sb of sandboxes) {
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
      const volumes = await VolumeInstance.list()
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
