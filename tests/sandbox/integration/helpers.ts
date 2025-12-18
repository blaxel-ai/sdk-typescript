import { SandboxInstance, VolumeInstance } from "@blaxel/core"
import { v4 as uuidv4 } from 'uuid'

/**
 * Environment-aware configuration
 */
export const env = process.env.BL_ENV || "prod"
export const defaultRegion = env === "dev" ? "eu-dub-1" : "us-pdx-1"
export const defaultImage = "blaxel/base-image:latest"

/**
 * Default labels to identify test sandboxes in the UI
 */
export const defaultLabels = {
  env: "integration-test",
  "created-by": "vitest",
}

/**
 * Generate a unique sandbox name for testing
 */
export function uniqueName(prefix: string = "test"): string {
  return `${prefix}-${uuidv4().replace(/-/g, '').substring(0, 8)}`
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
 * Waits for a volume deletion to fully complete by polling until the volume no longer exists
 * @param volumeName The name of the volume to wait for deletion
 * @param maxAttempts Maximum number of attempts to wait (default: 30 seconds)
 * @returns Promise<boolean> - true if deletion completed, false if timeout
 */
export async function waitForVolumeDeletion(volumeName: string, maxAttempts: number = 30): Promise<boolean> {
  let attempts = 0

  while (attempts < maxAttempts) {
    try {
      await VolumeInstance.get(volumeName)
      // If we get here, volume still exists, wait and try again
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
