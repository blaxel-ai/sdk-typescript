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
 * Clean up all tracked resources in parallel
 */
export async function cleanupAll(): Promise<void> {
  // Clean up sandboxes in parallel
  const sandboxCleanups = trackedSandboxes.map(async (name) => {
    try {
      await SandboxInstance.delete(name)
      await waitForSandboxDeletion(name)
    } catch {
      // Ignore errors during cleanup
    }
  })
  await Promise.all(sandboxCleanups)
  trackedSandboxes.length = 0

  // Clean up volumes in parallel (after sandboxes are deleted)
  const volumeCleanups = trackedVolumes.map(async (name) => {
    try {
      await VolumeInstance.delete(name)
    } catch {
      // Ignore errors during cleanup
    }
  })
  await Promise.all(volumeCleanups)
  trackedVolumes.length = 0
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
 * Waits for a sandbox deletion to fully complete by polling until the sandbox no longer exists
 * @param sandboxName The name of the sandbox to wait for deletion
 * @param maxAttempts Maximum number of attempts to wait (default: 30 seconds)
 * @returns Promise<boolean> - true if deletion completed, false if timeout
 */
export async function waitForSandboxDeletion(sandboxName: string, maxAttempts: number = 30): Promise<boolean> {
  let attempts = 0

  while (attempts < maxAttempts) {
    try {
      await SandboxInstance.get(sandboxName)
      // If we get here, sandbox still exists, wait and try again
      await sleep(1000)
      attempts++
    } catch (error) {
      // If getSandbox throws an error, the sandbox no longer exists
      return true
    }
  }

  console.warn(`Timeout waiting for ${sandboxName} deletion to complete`)
  return false
}

/**
 * Waits for a sandbox deletion to fully complete by polling until the sandbox no longer exists
 * @param volumeName The name of the volume to wait for deletion
 * @param maxAttempts Maximum number of attempts to wait (default: 30 seconds)
 * @returns Promise<boolean> - true if deletion completed, false if timeout
 */
export async function waitForVolumeDeletion(volumeName: string, maxAttempts: number = 30): Promise<boolean> {
  let attempts = 0

  while (attempts < maxAttempts) {
    try {
      await VolumeInstance.get(volumeName)
      // If we get here, sandbox still exists, wait and try again
      await sleep(1000)
      attempts++
    } catch (error) {
      // If getVolume throws an error, the volume no longer exists
      return true
    }
  }

  console.warn(`Timeout waiting for ${volumeName} deletion to complete`)
  return false
}

/**
 * Sleep helper
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
