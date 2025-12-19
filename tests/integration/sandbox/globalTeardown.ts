import { SandboxInstance, VolumeInstance } from "@blaxel/core"

/**
 * Global teardown - runs once after ALL tests complete
 * This cleans up any sandboxes/volumes with test labels
 */
export default async function globalTeardown() {
  console.log("\n🧹 Cleaning up test resources...")

  // Clean up sandboxes with test labels
  try {
    const sandboxes = await SandboxInstance.list()
    for (const sb of sandboxes) {
      const labels = sb.metadata?.labels || {}
      if (labels["env"] === "integration-test") {
        try {
          await SandboxInstance.delete(sb.metadata?.name!)
        } catch {
          // Ignore deletion errors
        }
      }
    }
  } catch (e) {
    console.log(`  Error listing sandboxes: ${e}`)
  }

  // Clean up volumes with test labels
  try {
    const volumes = await VolumeInstance.list()
    for (const vol of volumes) {
      const labels = (vol as any).metadata?.labels || {}
      if (labels["env"] === "integration-test") {
        try {
          await VolumeInstance.delete(vol.name!)
        } catch {
          // Ignore deletion errors
        }
      }
    }
  } catch (e) {
    console.log(`  Error listing volumes: ${e}`)
  }

  console.log("✅ Cleanup complete!")
}
