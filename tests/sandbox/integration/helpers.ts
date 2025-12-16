import { SandboxInstance, SandboxCreateConfiguration, VolumeInstance } from "@blaxel/core"
import { v4 as uuidv4 } from 'uuid'

/**
 * Environment-aware configuration
 */
export const env = process.env.BL_ENV || "prod"
export const defaultRegion = env === "dev" ? "eu-dub-1" : "us-pdx-1"
export const defaultImage = "blaxel/base-image:latest"

/**
 * Generate a unique sandbox name for testing
 */
export function uniqueName(prefix: string = "test"): string {
  return `${prefix}-${uuidv4().replace(/-/g, '').substring(0, 8)}`
}

/**
 * Tracked resources for cleanup
 */
const trackedSandboxes: string[] = []
const trackedVolumes: string[] = []

/**
 * Create a sandbox and track it for cleanup
 */
export async function createTrackedSandbox(config: SandboxCreateConfiguration = {}): Promise<SandboxInstance> {
  const name = config.name || uniqueName("sandbox")
  const sandbox = await SandboxInstance.create({
    name,
    image: config.image || defaultImage,
    memory: config.memory || 2048,
    region: config.region || defaultRegion,
    ...config
  })
  trackedSandboxes.push(name)
  return sandbox
}

/**
 * Create a volume and track it for cleanup
 */
export async function createTrackedVolume(name?: string, size: number = 1024): Promise<VolumeInstance> {
  const volumeName = name || uniqueName("volume")
  const volume = await VolumeInstance.create({
    name: volumeName,
    size,
    region: defaultRegion
  })
  trackedVolumes.push(volumeName)
  return volume
}

/**
 * Clean up all tracked resources
 */
export async function cleanupAll(): Promise<void> {
  const errors: Error[] = []

  // Clean up sandboxes
  for (const name of trackedSandboxes) {
    try {
      await SandboxInstance.delete(name)
    } catch (e) {
      // Ignore errors during cleanup
      errors.push(e as Error)
    }
  }
  trackedSandboxes.length = 0

  // Clean up volumes
  for (const name of trackedVolumes) {
    try {
      await VolumeInstance.delete(name)
    } catch (e) {
      // Ignore errors during cleanup
      errors.push(e as Error)
    }
  }
  trackedVolumes.length = 0

  if (errors.length > 0) {
    console.warn(`Cleanup completed with ${errors.length} errors (ignored)`)
  }
}

/**
 * Delete a specific sandbox (safe - ignores errors)
 */
export async function deleteSandboxSafe(name: string): Promise<void> {
  try {
    await SandboxInstance.delete(name)
  } catch {
    // Ignore
  }
}

/**
 * Wait for a sandbox to be deleted
 */
export async function waitForDeletion(name: string, maxAttempts: number = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const status = await SandboxInstance.get(name)
      if (status.status === "DELETED" || status.status === "TERMINATED") {
        return true
      }
      await sleep(1000)
    } catch {
      // Sandbox no longer exists
      return true
    }
  }
  return false
}

/**
 * Sleep helper
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
