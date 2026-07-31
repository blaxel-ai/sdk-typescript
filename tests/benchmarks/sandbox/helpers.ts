import { SandboxInstance, VolumeInstance } from "@blaxel/core"

export const defaultImage = "blaxel/base-image:latest"

/**
 * Default labels to identify benchmark sandboxes in the UI
 */
export const defaultLabels = {
  env: "benchmark",
  language: "typescript",
  "created-by": "vitest-bench",
}

/**
 * Generate a unique sandbox name for benchmarking
 */
export function uniqueName(prefix: string = "bench"): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').substring(0, 8)}`
}

/**
 * Sleep helper
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Waits for a sandbox deletion to fully complete
 */
export async function waitForSandboxDeletion(sandboxName: string, maxAttempts: number = 30): Promise<boolean> {
  let attempts = 0
  while (attempts < maxAttempts) {
    try {
      await SandboxInstance.get(sandboxName)
      await sleep(1000)
      attempts++
    } catch {
      return true
    }
  }
  return false
}

/**
 * Waits for a volume deletion to fully complete
 */
export async function waitForVolumeDeletion(volumeName: string, maxAttempts: number = 30): Promise<boolean> {
  let attempts = 0
  while (attempts < maxAttempts) {
    try {
      await VolumeInstance.get(volumeName)
      await sleep(1000)
      attempts++
    } catch {
      return true
    }
  }
  return false
}
