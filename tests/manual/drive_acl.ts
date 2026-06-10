/**
 * Manual test for per-drive ACL enforcement (ENG-2761).
 *
 * Prerequisites (all three PRs must be deployed):
 *   - controlplane#4206  — DrivePermission model + ACL sync to filer
 *   - seaweedfs#27       — filer-side ACL enforcement
 *   - executionplane#171 — blaxel.ai/labels in workload identity JWT
 *
 * Environment variables:
 *   BL_WORKSPACE  — workspace name
 *   BL_API_KEY    — API key with drive + sandbox permissions
 *   BL_ENV        — "dev" or "prod" (default: "dev")
 *   BL_DRIVE_REGION — drive region override (default: eu-dub-1 for dev, us-was-1 for prod)
 *
 * Usage:
 *   npx tsx tests/manual/drive_acl.ts
 *   npx tsx tests/manual/drive_acl.ts --scenario open-access
 *   npx tsx tests/manual/drive_acl.ts --scenario label-match
 */

import { DriveInstance, SandboxInstance } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ENV = process.env.BL_ENV || "dev"
const REGION = process.env.BL_DRIVE_REGION || (ENV === "dev" ? "eu-dub-1" : "us-was-1")
const IMAGE = "blaxel/base-image:latest"
const TEST_LABELS = { env: "manual-test", "created-by": "drive-acl-test" }
const EXEC_TIMEOUT_MS = 30_000
const MOUNT_SETTLE_MS = 3_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid(prefix: string): string {
  return `${prefix}-${uuidv4().replace(/-/g, "").substring(0, 8)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e: unknown) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))) },
    )
  })
}

type DrivePermission = {
  labels?: Record<string, string>
  mode?: "read" | "read-write"
  path?: string
}

async function createDriveWithPermissions(
  name: string,
  permissions: DrivePermission[],
): Promise<DriveInstance> {
  // The SDK types don't include `permissions` yet, so we pass a raw Drive
  // object with the extra field — the API accepts it.
  const body = {
    metadata: { name, labels: TEST_LABELS },
    spec: {
      region: REGION,
      size: 1,
      permissions,
    },
  }
  // DriveInstance.create accepts Drive | DriveCreateConfiguration.
  // Cast to any to include the permissions field that isn't in the generated type yet.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  return DriveInstance.create(body as any)
}

async function createSandbox(
  name: string,
  labels: Record<string, string>,
): Promise<SandboxInstance> {
  return SandboxInstance.create({
    name,
    image: IMAGE,
    memory: 2048,
    region: REGION,
    labels: { ...TEST_LABELS, ...labels },
  }, { safe: true })
}

async function execInSandbox(
  sbx: SandboxInstance,
  command: string,
): Promise<{ ok: boolean; logs: string }> {
  try {
    const result = await withTimeout(
      sbx.process.exec({ command, waitForCompletion: true }),
      EXEC_TIMEOUT_MS,
      `exec: ${command}`,
    )
    return { ok: true, logs: result.logs ?? "" }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, logs: msg }
  }
}

// ---------------------------------------------------------------------------
// Cleanup tracker
// ---------------------------------------------------------------------------

const cleanupSandboxes: string[] = []
const cleanupDrives: string[] = []

async function cleanup() {
  console.log("\n--- Cleanup ---")
  for (const name of cleanupSandboxes) {
    try {
      await SandboxInstance.delete(name)
      console.log(`  deleted sandbox ${name}`)
    } catch { /* ignore */ }
  }
  // Wait for sandboxes to terminate before deleting drives
  await sleep(5_000)
  for (const name of cleanupDrives) {
    try {
      await DriveInstance.delete(name)
      console.log(`  deleted drive ${name}`)
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

type TestResult = { name: string; passed: boolean; detail: string }
const results: TestResult[] = []

function record(name: string, passed: boolean, detail: string) {
  const icon = passed ? "PASS" : "FAIL"
  console.log(`  [${icon}] ${name}: ${detail}`)
  results.push({ name, passed, detail })
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * Scenario 1: Drive with NO permissions (empty array) — backward compat.
 * Any sandbox in the workspace should be able to mount, read, and write.
 */
async function scenarioOpenAccess() {
  console.log("\n=== Scenario: open-access (no permissions = allow all) ===")
  const driveName = uid("acl-open")
  const sbxName = uid("acl-open-sbx")

  await createDriveWithPermissions(driveName, [])
  cleanupDrives.push(driveName)

  const sbx = await createSandbox(sbxName, { role: "anything" })
  cleanupSandboxes.push(sbxName)

  await sbx.drives.mount({ driveName, mountPath: "/mnt/open" })
  await sleep(MOUNT_SETTLE_MS)

  const write = await execInSandbox(sbx, "echo 'open-access-ok' > /mnt/open/test.txt")
  record("open-access write", write.ok, write.ok ? "wrote successfully" : write.logs)

  const read = await execInSandbox(sbx, "cat /mnt/open/test.txt")
  record("open-access read", read.ok && read.logs.includes("open-access-ok"), read.logs.trim())
}

/**
 * Scenario 2: Drive with a label-based permission — matching sandbox.
 * Sandbox with the correct labels should get full read-write access.
 */
async function scenarioLabelMatch() {
  console.log("\n=== Scenario: label-match (sandbox has matching labels) ===")
  const driveName = uid("acl-match")
  const sbxName = uid("acl-match-sbx")

  await createDriveWithPermissions(driveName, [
    { labels: { team: "backend", project: "acl-test" }, mode: "read-write" },
  ])
  cleanupDrives.push(driveName)

  const sbx = await createSandbox(sbxName, { team: "backend", project: "acl-test" })
  cleanupSandboxes.push(sbxName)

  await sbx.drives.mount({ driveName, mountPath: "/mnt/match" })
  await sleep(MOUNT_SETTLE_MS)

  const write = await execInSandbox(sbx, "echo 'label-match-ok' > /mnt/match/test.txt")
  record("label-match write", write.ok, write.ok ? "wrote successfully" : write.logs)

  const read = await execInSandbox(sbx, "cat /mnt/match/test.txt")
  record("label-match read", read.ok && read.logs.includes("label-match-ok"), read.logs.trim())
}

/**
 * Scenario 3: Drive with a label-based permission — NON-matching sandbox.
 * Sandbox WITHOUT the required labels should be denied read and write.
 */
async function scenarioLabelMismatch() {
  console.log("\n=== Scenario: label-mismatch (sandbox lacks required labels) ===")
  const driveName = uid("acl-mis")
  const sbxName = uid("acl-mis-sbx")

  await createDriveWithPermissions(driveName, [
    { labels: { team: "secret-team" }, mode: "read-write" },
  ])
  cleanupDrives.push(driveName)

  // Sandbox has team=other, not team=secret-team
  const sbx = await createSandbox(sbxName, { team: "other" })
  cleanupSandboxes.push(sbxName)

  await sbx.drives.mount({ driveName, mountPath: "/mnt/mis" })
  await sleep(MOUNT_SETTLE_MS)

  const write = await execInSandbox(sbx, "echo 'should-fail' > /mnt/mis/test.txt")
  record(
    "label-mismatch write denied",
    !write.ok || write.logs.includes("denied") || write.logs.includes("Permission") || write.logs.includes("error"),
    write.ok ? `unexpected success: ${write.logs.trim()}` : "write denied as expected",
  )

  const read = await execInSandbox(sbx, "cat /mnt/mis/test.txt")
  record(
    "label-mismatch read denied",
    !read.ok || read.logs.includes("denied") || read.logs.includes("No such file") || read.logs.includes("error"),
    read.ok ? `read returned: ${read.logs.trim()}` : "read denied as expected",
  )
}

/**
 * Scenario 4: Read-only mode enforcement.
 * Sandbox with matching labels but mode=read should be able to read but NOT write.
 */
async function scenarioReadOnly() {
  console.log("\n=== Scenario: read-only (mode=read blocks writes) ===")
  const driveName = uid("acl-ro")
  const writerName = uid("acl-ro-writer")
  const readerName = uid("acl-ro-reader")

  await createDriveWithPermissions(driveName, [
    { labels: { role: "reader" }, mode: "read" },
    { labels: { role: "writer" }, mode: "read-write" },
  ])
  cleanupDrives.push(driveName)

  // Writer sandbox: write a file first
  const writer = await createSandbox(writerName, { role: "writer" })
  cleanupSandboxes.push(writerName)
  await writer.drives.mount({ driveName, mountPath: "/mnt/ro" })
  await sleep(MOUNT_SETTLE_MS)

  const seed = await execInSandbox(writer, "echo 'read-only-test-data' > /mnt/ro/readonly.txt")
  record("read-only seed write", seed.ok, seed.ok ? "seeded data" : seed.logs)

  // Reader sandbox: should read but fail to write
  const reader = await createSandbox(readerName, { role: "reader" })
  cleanupSandboxes.push(readerName)
  await reader.drives.mount({ driveName, mountPath: "/mnt/ro" })
  await sleep(MOUNT_SETTLE_MS)

  const read = await execInSandbox(reader, "cat /mnt/ro/readonly.txt")
  record("read-only read succeeds", read.ok && read.logs.includes("read-only-test-data"), read.logs.trim())

  const write = await execInSandbox(reader, "echo 'should-fail' > /mnt/ro/illegal.txt")
  record(
    "read-only write denied",
    !write.ok || write.logs.includes("denied") || write.logs.includes("Read-only") || write.logs.includes("Permission") || write.logs.includes("error"),
    write.ok ? `unexpected success: ${write.logs.trim()}` : "write denied as expected",
  )
}

/**
 * Scenario 5: Multiple permissions with OR logic.
 * Two permissions: one for team=alpha, one for team=beta.
 * Sandbox with team=beta (second rule) should get access.
 */
async function scenarioMultiplePermissionsOR() {
  console.log("\n=== Scenario: multiple-permissions-or (first match wins) ===")
  const driveName = uid("acl-or")
  const sbxName = uid("acl-or-sbx")

  await createDriveWithPermissions(driveName, [
    { labels: { team: "alpha" }, mode: "read-write" },
    { labels: { team: "beta" }, mode: "read-write" },
  ])
  cleanupDrives.push(driveName)

  // Sandbox only has team=beta — should match the second permission
  const sbx = await createSandbox(sbxName, { team: "beta" })
  cleanupSandboxes.push(sbxName)

  await sbx.drives.mount({ driveName, mountPath: "/mnt/or" })
  await sleep(MOUNT_SETTLE_MS)

  const write = await execInSandbox(sbx, "echo 'or-logic-ok' > /mnt/or/test.txt")
  record("or-logic write", write.ok, write.ok ? "wrote successfully" : write.logs)

  const read = await execInSandbox(sbx, "cat /mnt/or/test.txt")
  record("or-logic read", read.ok && read.logs.includes("or-logic-ok"), read.logs.trim())
}

/**
 * Scenario 6: AND logic within a single permission.
 * Permission requires BOTH team=core AND env=staging.
 * Sandbox with only team=core (missing env=staging) should be denied.
 */
async function scenarioANDLogic() {
  console.log("\n=== Scenario: and-logic (all labels must match within a permission) ===")
  const driveName = uid("acl-and")
  const sbxNamePartial = uid("acl-and-partial")
  const sbxNameFull = uid("acl-and-full")

  await createDriveWithPermissions(driveName, [
    { labels: { team: "core", tier: "staging" }, mode: "read-write" },
  ])
  cleanupDrives.push(driveName)

  // Partial match: has team=core but NOT tier=staging
  const partial = await createSandbox(sbxNamePartial, { team: "core" })
  cleanupSandboxes.push(sbxNamePartial)
  await partial.drives.mount({ driveName, mountPath: "/mnt/and" })
  await sleep(MOUNT_SETTLE_MS)

  const partialWrite = await execInSandbox(partial, "echo 'should-fail' > /mnt/and/test.txt")
  record(
    "and-logic partial denied",
    !partialWrite.ok || partialWrite.logs.includes("denied") || partialWrite.logs.includes("Permission") || partialWrite.logs.includes("error"),
    partialWrite.ok ? `unexpected success: ${partialWrite.logs.trim()}` : "denied as expected",
  )

  // Full match: has both team=core AND tier=staging
  const full = await createSandbox(sbxNameFull, { team: "core", tier: "staging" })
  cleanupSandboxes.push(sbxNameFull)
  await full.drives.mount({ driveName, mountPath: "/mnt/and" })
  await sleep(MOUNT_SETTLE_MS)

  const fullWrite = await execInSandbox(full, "echo 'and-logic-ok' > /mnt/and/test.txt")
  record("and-logic full-match write", fullWrite.ok, fullWrite.ok ? "wrote successfully" : fullWrite.logs)
}

/**
 * Scenario 7: Path scoping.
 * Permission restricts access to /data/ subfolder.
 * Sandbox should access /data/ but NOT the root.
 */
async function scenarioPathScoping() {
  console.log("\n=== Scenario: path-scoping (permission restricts to subfolder) ===")
  const driveName = uid("acl-path")
  const writerName = uid("acl-path-writer")
  const scopedName = uid("acl-path-scoped")

  await createDriveWithPermissions(driveName, [
    { labels: { role: "admin" }, mode: "read-write", path: "/" },
    { labels: { role: "scoped" }, mode: "read-write", path: "/data" },
  ])
  cleanupDrives.push(driveName)

  // Admin sandbox: seed data in both root and /data/
  const admin = await createSandbox(writerName, { role: "admin" })
  cleanupSandboxes.push(writerName)
  await admin.drives.mount({ driveName, mountPath: "/mnt/path" })
  await sleep(MOUNT_SETTLE_MS)

  await execInSandbox(admin, "echo 'root-secret' > /mnt/path/secret.txt")
  await execInSandbox(admin, "mkdir -p /mnt/path/data && echo 'data-ok' > /mnt/path/data/file.txt")

  // Scoped sandbox: should access /data/ but not root
  const scoped = await createSandbox(scopedName, { role: "scoped" })
  cleanupSandboxes.push(scopedName)
  await scoped.drives.mount({ driveName, mountPath: "/mnt/path" })
  await sleep(MOUNT_SETTLE_MS)

  const readData = await execInSandbox(scoped, "cat /mnt/path/data/file.txt")
  record("path-scoping /data read", readData.ok && readData.logs.includes("data-ok"), readData.logs.trim())

  const readRoot = await execInSandbox(scoped, "cat /mnt/path/secret.txt")
  record(
    "path-scoping root denied",
    !readRoot.ok || readRoot.logs.includes("denied") || readRoot.logs.includes("Permission") || readRoot.logs.includes("No such file"),
    readRoot.ok ? `unexpected: ${readRoot.logs.trim()}` : "root access denied as expected",
  )
}

/**
 * Scenario 8: Wildcard permission (empty labels = match all workloads).
 * A permission with no labels should match any sandbox.
 */
async function scenarioWildcardPermission() {
  console.log("\n=== Scenario: wildcard-permission (empty labels match all) ===")
  const driveName = uid("acl-wild")
  const sbxName = uid("acl-wild-sbx")

  await createDriveWithPermissions(driveName, [
    { labels: {}, mode: "read", path: "/" },
  ])
  cleanupDrives.push(driveName)

  const sbx = await createSandbox(sbxName, { random: "anything" })
  cleanupSandboxes.push(sbxName)

  await sbx.drives.mount({ driveName, mountPath: "/mnt/wild" })
  await sleep(MOUNT_SETTLE_MS)

  const read = await execInSandbox(sbx, "ls /mnt/wild/ 2>&1 || echo 'ls-failed'")
  record("wildcard-permission read", read.ok, read.logs.trim())

  const write = await execInSandbox(sbx, "echo 'should-fail' > /mnt/wild/test.txt")
  record(
    "wildcard-permission write denied (mode=read)",
    !write.ok || write.logs.includes("denied") || write.logs.includes("Read-only") || write.logs.includes("Permission") || write.logs.includes("error"),
    write.ok ? `unexpected success: ${write.logs.trim()}` : "write denied as expected (mode=read)",
  )
}

// ---------------------------------------------------------------------------
// Scenario registry
// ---------------------------------------------------------------------------

const SCENARIOS: Record<string, () => Promise<void>> = {
  "open-access": scenarioOpenAccess,
  "label-match": scenarioLabelMatch,
  "label-mismatch": scenarioLabelMismatch,
  "read-only": scenarioReadOnly,
  "multiple-permissions-or": scenarioMultiplePermissionsOR,
  "and-logic": scenarioANDLogic,
  "path-scoping": scenarioPathScoping,
  "wildcard-permission": scenarioWildcardPermission,
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const scenarioIdx = args.indexOf("--scenario")
  const selectedScenario = scenarioIdx !== -1 ? args[scenarioIdx + 1] : undefined

  console.log("Drive ACL Manual Test (ENG-2761)")
  console.log(`  env=${ENV}  region=${REGION}`)
  console.log(`  scenarios=${selectedScenario || "all"}`)

  const toRun = selectedScenario
    ? { [selectedScenario]: SCENARIOS[selectedScenario] }
    : SCENARIOS

  if (selectedScenario && !SCENARIOS[selectedScenario]) {
    console.error(`Unknown scenario: ${selectedScenario}`)
    console.error(`Available: ${Object.keys(SCENARIOS).join(", ")}`)
    process.exit(1)
  }

  try {
    for (const [name, fn] of Object.entries(toRun)) {
      try {
        await fn()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        record(`${name} (scenario error)`, false, msg)
      }
    }
  } finally {
    await cleanup()
  }

  // Summary
  console.log("\n" + "=".repeat(60))
  console.log("SUMMARY")
  console.log("=".repeat(60))

  const passed = results.filter((r) => r.passed)
  const failed = results.filter((r) => !r.passed)

  console.log(`  Total:  ${results.length}`)
  console.log(`  Passed: ${passed.length}`)
  console.log(`  Failed: ${failed.length}`)

  if (failed.length > 0) {
    console.log("\nFailed checks:")
    for (const f of failed) {
      console.log(`  - ${f.name}: ${f.detail}`)
    }
  }

  console.log()
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error("Fatal:", err)
  void cleanup().finally(() => process.exit(1))
})
