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
  language: "typescript",
  "created-by": "vitest-integration",
}

/**
 * Generate a unique sandbox name for testing
 */
export function uniqueName(prefix: string = "test"): string {
  return `${prefix}-${uuidv4().replace(/-/g, '').substring(0, 8)}`
}

/**
 * Waits for a sandbox to be deployed by polling until status is DEPLOYED
 * @param sandboxName The name of the sandbox to wait for
 * @param maxAttempts Maximum number of attempts to wait (default: 30 seconds)
 * @returns Promise<boolean> - true if deployed, false if timeout
 */
export async function waitForSandboxDeployed(sandboxName: string, maxAttempts: number = 30): Promise<boolean> {
  let attempts = 0

  while (attempts < maxAttempts) {
    const sandbox = await SandboxInstance.get(sandboxName)
    if (sandbox.status === "DEPLOYED") {
      return true
    }
    await sleep(1000)
    attempts++
  }

  console.warn(`Timeout waiting for ${sandboxName} to be deployed`)
  return false
}

/**
 * Waits for a sandbox to reach TERMINATED status by polling
 * @param sandboxName The name of the sandbox to wait for
 * @param maxAttempts Maximum number of attempts to wait (default: 30 seconds)
 * @returns Promise<boolean> - true if terminated, false if timeout
 */
export async function waitForSandboxTerminated(sandboxName: string, maxAttempts: number = 30): Promise<boolean> {
  let attempts = 0

  while (attempts < maxAttempts) {
    const sandbox = await SandboxInstance.get(sandboxName)
    if (sandbox.status === "TERMINATED") {
      return true
    }
    await sleep(1000)
    attempts++
  }

  console.warn(`Timeout waiting for ${sandboxName} to be terminated`)
  return false
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
    } catch {
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
    } catch {
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

/**
 * Fetch with retries for transient failures (401/5xx) during infra propagation.
 */
export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  { retries = 5, delayMs = 500 }: { retries?: number; delayMs?: number } = {}
): Promise<Response> {
  let lastResponse: Response | undefined
  for (let i = 0; i <= retries; i++) {
    lastResponse = await fetch(url, options)
    if (lastResponse.status !== 401 && lastResponse.status < 500) {
      return lastResponse
    }
    if (i < retries) {
      await sleep(delayMs)
    }
  }
  return lastResponse!
}

/**
 * Retry a callback until it succeeds or max retries reached.
 * Useful for infra operations that may hit transient 404/409 during redeployment.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  { retries = 5, delayMs = 2000, shouldRetry }: { retries?: number; delayMs?: number; shouldRetry?: (err: unknown) => boolean } = {}
): Promise<T> {
  let lastError: unknown
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (shouldRetry && !shouldRetry(err)) throw err
      if (i < retries) await sleep(delayMs)
    }
  }
  throw lastError
}
