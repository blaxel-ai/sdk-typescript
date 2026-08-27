import { getWorkspaceFeatures, SandboxInstance, settings, VolumeInstance } from "@blaxel/core"
import { v4 as uuidv4 } from 'uuid'
import { expect } from 'vitest'

/**
 * Environment-aware configuration
 */
export const env = process.env.BL_ENV || "prod"
export const defaultRegion = process.env.BL_REGION || (env === "dev" ? "eu-dub-1" : "us-was-1")
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
 * Whether an opt-in slow test flag is enabled. Defaults for every flag live in
 * vitest.config.ts (test.env), all "false". Use with describe.runIf/it.runIf,
 * e.g. describe.runIf(isSlowTestEnabled("RUN_SLOW_SCHEDULES"))(...).
 */
export function isSlowTestEnabled(flag: string): boolean {
  const v = process.env[flag]
  return v === "true" || v === "1"
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
 * Waits for a sandbox deletion to fully complete by polling until the sandbox no longer exists
 * @param sandboxName The name of the sandbox to wait for deletion
 * @param maxAttempts Maximum number of attempts to wait (default: 30 seconds)
 * @returns Promise<boolean> - true if deletion completed, false if timeout
 */
export async function waitForSandboxDeletion(sandboxName: string, maxAttempts: number = 30): Promise<boolean> {
  let attempts = 0

  while (attempts < maxAttempts) {
    try {
      let sbx = await SandboxInstance.get(sandboxName)
      if (sbx.status === "TERMINATED") {
        return true
      }
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

type SandboxTtlEnforcement = {
  /** True on accounts where the control plane re-applies a floor TTL (tier_0/free, `sandbox_enforced_ttl=1`). */
  enforced: boolean
  /** The TTL string (e.g. "7d") the server re-applies whenever ttl/expires is unset, when enforced. */
  defaultTtl: string
}

let cachedTtlEnforcement: SandboxTtlEnforcement | null = null

/**
 * Resolves whether the current workspace's account enforces a minimum sandbox TTL.
 *
 * On enforced accounts (tier_0/free by default), the control plane's
 * `Sandbox.ApplyDefaultTTL` re-stamps a default TTL (e.g. "7d") any time
 * `spec.runtime.ttl` comes back nil after unmarshalling -- which is indistinguishable
 * from an explicit `updateTtl(name, null)` clear. So on these accounts, clearing the
 * TTL does not result in no TTL; it results in the tier's default TTL. Tests that
 * assert "TTL cleared" must account for this instead of asserting falsy unconditionally.
 *
 * There's no generated SDK client for the quotas endpoint yet, so this does a raw
 * fetch: GET /workspaces/{name} for accountId, then GET /quotas/account/{accountId}.
 * Result is cached for the process lifetime since it's account-wide, not per-sandbox.
 */
export async function getSandboxTtlEnforcement(): Promise<SandboxTtlEnforcement> {
  if (cachedTtlEnforcement) return cachedTtlEnforcement

  const fallback: SandboxTtlEnforcement = { enforced: false, defaultTtl: "" }

  try {
    const workspaceRes = await fetch(`${settings.baseUrl}/workspaces/${settings.workspace}`, {
      headers: settings.headers,
    })
    if (!workspaceRes.ok) return (cachedTtlEnforcement = fallback)

    const workspace = await workspaceRes.json() as { accountId?: string }
    if (!workspace.accountId) return (cachedTtlEnforcement = fallback)

    const quotasRes = await fetch(`${settings.baseUrl}/quotas/account/${workspace.accountId}`, {
      headers: settings.headers,
    })
    if (!quotasRes.ok) return (cachedTtlEnforcement = fallback)

    const quotas = await quotasRes.json() as Array<{ resourceType: string; value: number }>
    const enforcedValue = quotas.find(q => q.resourceType === "sandbox_enforced_ttl")?.value ?? 0
    const sandboxTtlDays = quotas.find(q => q.resourceType === "sandbox_ttl")?.value ?? 0

    return (cachedTtlEnforcement = {
      enforced: enforcedValue !== 0,
      defaultTtl: sandboxTtlDays > 0 ? `${sandboxTtlDays}d` : "",
    })
  } catch {
    return (cachedTtlEnforcement = fallback)
  }
}

/**
 * Asserts a sandbox's ttl matches what "cleared" means for the current account:
 * falsy on unenforced accounts, or the account's floor TTL on enforced (free-tier) accounts.
 */
export async function expectTtlCleared(ttl: string | null | undefined): Promise<void> {
  const { enforced, defaultTtl } = await getSandboxTtlEnforcement()
  if (enforced) {
    expect(defaultTtl).toBeTruthy()
    expect(ttl).toBe(defaultTtl)
  } else {
    expect(ttl).toBeFalsy()
  }
}

const GENERATION_MK31_FEATURE = "generation_mk31"
const REQUIRE_GENERATION_MK31_ENV = "BL_REQUIRE_GENERATION_MK31"

let cachedWorkspaceFeatures: Record<string, boolean> | null = null

/**
 * Whether a feature flag is enabled on the tested workspace.
 */
export async function workspaceFeatureEnabled(feature: string): Promise<boolean> {
  if (!cachedWorkspaceFeatures) {
    const { data } = await getWorkspaceFeatures({ throwOnError: true })
    cachedWorkspaceFeatures = data.features ?? {}
  }
  return cachedWorkspaceFeatures[feature] === true
}

/**
 * Skips the calling test when the workspace does not run sandboxes on mk3.1.
 *
 * Sandboxes are mk3.0 unless the workspace is granted mk3.1, and mk3.0 has no
 * mk3.1-only feature (snapshots, ephemeral volumes, ...). Set
 * BL_REQUIRE_GENERATION_MK31=1 in a lane meant to run on mk3.1 to turn the skip
 * into a failure.
 *
 * @param ctx the vitest test context, used to skip
 * @param what the mk3.1-only capability the test exercises, used in the message
 */
export async function skipUnlessGenerationMk31(
  ctx: { skip: (note?: string) => void },
  what: string
): Promise<void> {
  if (await workspaceFeatureEnabled(GENERATION_MK31_FEATURE)) return

  const message = `${what} require the ${GENERATION_MK31_FEATURE} workspace feature; set ${REQUIRE_GENERATION_MK31_ENV}=1 in the MK3.1 lane to make absence a failure`
  if (process.env[REQUIRE_GENERATION_MK31_ENV] === "1") {
    throw new Error(message)
  }
  ctx.skip(message)
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
