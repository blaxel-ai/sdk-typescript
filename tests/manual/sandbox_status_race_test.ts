/**
 * Comprehensive sandbox status & race condition test.
 *
 * Tests multiple scenarios to verify that the denormalized ComputedStatus
 * (used by list) matches the event-computed status (used by get) under
 * various conditions including rapid creation, concurrent operations,
 * and lifecycle transitions.
 *
 * Test suites:
 *   1. Rapid batch creation — create N sandboxes concurrently, verify list vs get
 *   2. Create-then-delete race — create and immediately delete, verify no ghost records
 *   3. Update-after-deploy — update metadata after DEPLOYED, verify status preserved
 *   4. Concurrent creates — burst-create sandboxes and verify all reach DEPLOYED
 *   5. Status distribution — statistical analysis of status consistency
 *
 * Usage:
 *   npx tsx tests/manual/sandbox_status_race_test.ts
 *   npx tsx tests/manual/sandbox_status_race_test.ts --suite=rapid
 *   npx tsx tests/manual/sandbox_status_race_test.ts --suite=delete-race
 *   npx tsx tests/manual/sandbox_status_race_test.ts --suite=update
 *   npx tsx tests/manual/sandbox_status_race_test.ts --suite=concurrent
 *   npx tsx tests/manual/sandbox_status_race_test.ts --suite=all
 *
 * Environment variables:
 *   TOTAL        Number of sandboxes per suite (default: 20)
 *   PARALLEL     Concurrency limit (default: 10)
 *   POLL_MS      Polling interval for status checks (default: 1000)
 *   POLL_MAX_MS  Max wait for DEPLOYED status (default: 120000)
 *
 * Requires BL_WORKSPACE and BL_API_KEY (or logged-in bl CLI).
 */

import { SandboxInstance } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason)
})
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err)
  process.exit(1)
})

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TOTAL = parseInt(process.env.TOTAL || "20", 10)
const PARALLEL = parseInt(process.env.PARALLEL || "10", 10)
const POLL_MS = parseInt(process.env.POLL_MS || "1000", 10)
const POLL_MAX_MS = parseInt(process.env.POLL_MAX_MS || "120000", 10)
const IMAGE = "blaxel/base-image:latest"
const LABEL_KEY = "created-by"
const LABEL_VALUE = "status-race-test"
const LABELS: Record<string, string> = { env: "manual-test", [LABEL_KEY]: LABEL_VALUE }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function uniqueName(prefix: string): string {
  return `${prefix}-${uuidv4().replace(/-/g, "").substring(0, 8)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function elapsed(startMs: number): string {
  return `${((Date.now() - startMs) / 1000).toFixed(1)}s`
}

async function waitForStatus(
  name: string,
  targetStatuses: string[],
  maxMs = POLL_MAX_MS,
): Promise<{ status: string; events: { status?: string; time?: string; type?: string }[] }> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const sbx = await SandboxInstance.get(name)
      const status = sbx.status ?? "UNKNOWN"
      if (targetStatuses.includes(status)) {
        return { status, events: (sbx.events ?? []) as { status?: string; time?: string; type?: string }[] }
      }
    } catch {
      // not queryable yet
    }
    await sleep(POLL_MS)
  }
  return { status: "TIMEOUT", events: [] }
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  const queue = items.map((item, i) => ({ item, i }))
  async function worker() {
    while (queue.length > 0) {
      const entry = queue.shift()!
      await fn(entry.item, entry.i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
}

async function cleanupSandboxes(names: string[]): Promise<void> {
  console.log(`  Cleaning up ${names.length} sandboxes...`)
  await runPool(names, PARALLEL, async (name) => {
    try {
      await SandboxInstance.delete(name)
    } catch {
      // best effort
    }
  })
  console.log("  Cleanup complete.")
}

type TestResult = {
  suite: string
  total: number
  passed: number
  failed: number
  details: string[]
}

// ---------------------------------------------------------------------------
// Suite 1: Rapid batch creation — list vs get comparison
// ---------------------------------------------------------------------------
async function suiteRapidCreation(): Promise<TestResult> {
  const suite = "rapid-creation"
  console.log(`\n${"=".repeat(70)}`)
  console.log(`SUITE: ${suite} — Create ${TOTAL} sandboxes, compare list vs get`)
  console.log(`${"=".repeat(70)}`)

  const names: string[] = []
  const details: string[] = []
  let passed = 0
  let failed = 0
  const start = Date.now()

  try {
    // Create all sandboxes
    const indices = Array.from({ length: TOTAL }, (_, i) => i)
    await runPool(indices, PARALLEL, async (_, i) => {
      const name = uniqueName("rapid")
      names.push(name)
      console.log(`  [${i + 1}/${TOTAL}] Creating ${name}`)
      await SandboxInstance.create({ name, image: IMAGE, labels: LABELS, memory: 2048 })
    })
    console.log(`  All ${names.length} created in ${elapsed(start)}`)

    // Wait for all to reach DEPLOYED
    console.log("  Waiting for DEPLOYED status...")
    const statusMap = new Map<string, string>()
    await runPool([...names], PARALLEL, async (name) => {
      const { status } = await waitForStatus(name, ["DEPLOYED", "FAILED", "TERMINATED"])
      statusMap.set(name, status)
      if (status !== "DEPLOYED") {
        console.error(`  WARNING: ${name} reached ${status} (expected DEPLOYED)`)
      }
    })

    // Wait a bit for any lagging conditional writes
    await sleep(3000)

    // Fetch list and compare
    console.log("  Fetching list endpoint...")
    const allListed = await SandboxInstance.list()
    const listedByName = new Map<string, SandboxInstance>()
    for (const sbx of allListed) {
      if (sbx.metadata?.labels?.[LABEL_KEY] === LABEL_VALUE) {
        listedByName.set(sbx.metadata.name!, sbx)
      }
    }

    // Compare each
    for (const name of names) {
      try {
        const listStatus = listedByName.get(name)?.status ?? "NOT_IN_LIST"
        const got = await SandboxInstance.get(name)
        const getStatus = got.status ?? "UNKNOWN"

        if (listStatus === getStatus) {
          passed++
        } else {
          failed++
          const detail = `${name}: list=${listStatus} get=${getStatus}`
          details.push(detail)
          console.error(`  MISMATCH: ${detail}`)
        }
      } catch (err: unknown) {
        failed++
        const msg = err instanceof Error ? err.message : String(err)
        details.push(`${name}: ERROR ${msg}`)
      }
    }
  } finally {
    await cleanupSandboxes(names)
  }

  console.log(`  Completed in ${elapsed(start)}: ${passed} passed, ${failed} failed`)
  return { suite, total: names.length, passed, failed, details }
}

// ---------------------------------------------------------------------------
// Suite 2: Create-then-delete race — verify no ghost records
// ---------------------------------------------------------------------------
async function suiteDeleteRace(): Promise<TestResult> {
  const suite = "delete-race"
  const count = Math.min(TOTAL, 20) // cap to avoid too many dangling sandboxes
  console.log(`\n${"=".repeat(70)}`)
  console.log(`SUITE: ${suite} — Create ${count} sandboxes and delete immediately`)
  console.log(`${"=".repeat(70)}`)

  const names: string[] = []
  const details: string[] = []
  let passed = 0
  let failed = 0
  const start = Date.now()

  try {
    // Create and immediately delete
    const indices = Array.from({ length: count }, (_, i) => i)
    await runPool(indices, PARALLEL, async (_, i) => {
      const name = uniqueName("delrace")
      names.push(name)
      console.log(`  [${i + 1}/${count}] Create+delete ${name}`)
      try {
        await SandboxInstance.create({ name, image: IMAGE, labels: LABELS, memory: 2048 })
        // Delete immediately — this races with the deployment callback
        await SandboxInstance.delete(name)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`  [${i + 1}/${count}] Error: ${msg}`)
      }
    })

    // Wait for deletions to settle
    console.log("  Waiting 10s for deletions to settle...")
    await sleep(10000)

    // Verify: none of them should appear in list
    console.log("  Checking list for ghost records...")
    const allListed = await SandboxInstance.list()
    const ghosts = allListed.filter(
      (sbx) =>
        sbx.metadata?.labels?.[LABEL_KEY] === LABEL_VALUE &&
        names.includes(sbx.metadata?.name ?? ""),
    )

    // Also try to get each individually
    for (const name of names) {
      try {
        const sbx = await SandboxInstance.get(name)
        const status = sbx.status ?? "UNKNOWN"
        if (status === "TERMINATED" || status === "DELETING") {
          passed++
        } else {
          // Still exists with non-terminal status = potential ghost
          failed++
          const detail = `${name}: still exists with status=${status}`
          details.push(detail)
          console.error(`  GHOST: ${detail}`)
        }
      } catch {
        // 404 = correctly deleted
        passed++
      }
    }

    if (ghosts.length > 0) {
      console.error(`  Found ${ghosts.length} ghost records in list:`)
      for (const g of ghosts) {
        console.error(`    - ${g.metadata?.name}: status=${g.status}`)
      }
    }
  } finally {
    // Cleanup any that are still around
    await cleanupSandboxes(names)
  }

  console.log(`  Completed in ${elapsed(start)}: ${passed} passed, ${failed} failed`)
  return { suite, total: names.length, passed, failed, details }
}

// ---------------------------------------------------------------------------
// Suite 3: Update after deploy — verify status not clobbered
// ---------------------------------------------------------------------------
async function suiteUpdateAfterDeploy(): Promise<TestResult> {
  const suite = "update-after-deploy"
  const count = Math.min(TOTAL, 10) // updates are heavier
  console.log(`\n${"=".repeat(70)}`)
  console.log(`SUITE: ${suite} — Create ${count}, wait DEPLOYED, update metadata, verify status`)
  console.log(`${"=".repeat(70)}`)

  const names: string[] = []
  const details: string[] = []
  let passed = 0
  let failed = 0
  const start = Date.now()

  try {
    // Create sandboxes
    const indices = Array.from({ length: count }, (_, i) => i)
    await runPool(indices, PARALLEL, async (_, i) => {
      const name = uniqueName("upd")
      names.push(name)
      console.log(`  [${i + 1}/${count}] Creating ${name}`)
      await SandboxInstance.create({ name, image: IMAGE, labels: LABELS, memory: 2048 })
    })

    // Wait for DEPLOYED
    console.log("  Waiting for DEPLOYED...")
    await runPool([...names], PARALLEL, async (name) => {
      await waitForStatus(name, ["DEPLOYED", "FAILED", "TERMINATED"])
    })

    // Update metadata on each (this triggers a PUT which could race with status)
    console.log("  Updating metadata on each sandbox...")
    await runPool([...names], PARALLEL, async (name, i) => {
      try {
        await SandboxInstance.updateMetadata(name, {
          labels: { ...LABELS, "update-round": "1", index: String(i) },
        })
        console.log(`  [${i + 1}/${count}] Updated ${name}`)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`  [${i + 1}/${count}] Update failed for ${name}: ${msg}`)
      }
    })

    // Small delay then verify
    await sleep(3000)

    // Check list vs get after the update
    console.log("  Verifying list vs get after update...")
    const allListed = await SandboxInstance.list()
    const listedByName = new Map<string, SandboxInstance>()
    for (const sbx of allListed) {
      if (names.includes(sbx.metadata?.name ?? "")) {
        listedByName.set(sbx.metadata!.name!, sbx)
      }
    }

    for (const name of names) {
      try {
        const listStatus = listedByName.get(name)?.status ?? "NOT_IN_LIST"
        const got = await SandboxInstance.get(name)
        const getStatus = got.status ?? "UNKNOWN"

        if (listStatus === getStatus && getStatus === "DEPLOYED") {
          passed++
        } else if (listStatus !== getStatus) {
          failed++
          const detail = `${name}: list=${listStatus} get=${getStatus} (mismatch after update)`
          details.push(detail)
          console.error(`  MISMATCH: ${detail}`)
        } else {
          failed++
          const detail = `${name}: status=${getStatus} (expected DEPLOYED after update)`
          details.push(detail)
          console.error(`  UNEXPECTED: ${detail}`)
        }
      } catch (err: unknown) {
        failed++
        const msg = err instanceof Error ? err.message : String(err)
        details.push(`${name}: ERROR ${msg}`)
      }
    }
  } finally {
    await cleanupSandboxes(names)
  }

  console.log(`  Completed in ${elapsed(start)}: ${passed} passed, ${failed} failed`)
  return { suite, total: names.length, passed, failed, details }
}

// ---------------------------------------------------------------------------
// Suite 4: Concurrent burst creation — all at once
// ---------------------------------------------------------------------------
async function suiteConcurrentBurst(): Promise<TestResult> {
  const suite = "concurrent-burst"
  const count = Math.min(TOTAL, 20)
  console.log(`\n${"=".repeat(70)}`)
  console.log(`SUITE: ${suite} — Burst-create ${count} sandboxes simultaneously`)
  console.log(`${"=".repeat(70)}`)

  const names: string[] = []
  const details: string[] = []
  let passed = 0
  let failed = 0
  const start = Date.now()

  try {
    // Create all at once (no concurrency limit)
    const createPromises = Array.from({ length: count }, async (_, i) => {
      const name = uniqueName("burst")
      names.push(name)
      try {
        await SandboxInstance.create({ name, image: IMAGE, labels: LABELS, memory: 2048 })
        console.log(`  [${i + 1}/${count}] Created ${name}`)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`  [${i + 1}/${count}] Create failed: ${msg}`)
      }
    })
    await Promise.all(createPromises)
    console.log(`  All ${names.length} burst-created in ${elapsed(start)}`)

    // Wait for DEPLOYED
    console.log("  Waiting for DEPLOYED...")
    const statusResults = new Map<string, string>()
    await runPool([...names], PARALLEL, async (name) => {
      const { status } = await waitForStatus(name, ["DEPLOYED", "FAILED", "TERMINATED"])
      statusResults.set(name, status)
    })

    // Short wait then compare list vs get
    await sleep(3000)
    console.log("  Comparing list vs get...")
    const allListed = await SandboxInstance.list()
    const listedByName = new Map<string, SandboxInstance>()
    for (const sbx of allListed) {
      if (names.includes(sbx.metadata?.name ?? "")) {
        listedByName.set(sbx.metadata!.name!, sbx)
      }
    }

    for (const name of names) {
      try {
        const listStatus = listedByName.get(name)?.status ?? "NOT_IN_LIST"
        const got = await SandboxInstance.get(name)
        const getStatus = got.status ?? "UNKNOWN"
        const events = (got.events ?? []) as { status?: string; time?: string }[]

        if (listStatus === getStatus) {
          passed++
        } else {
          failed++
          const eventSummary = events.map((e) => `${e.status}@${e.time?.split("T")[1]?.substring(0, 12)}`).join(" -> ")
          const detail = `${name}: list=${listStatus} get=${getStatus} events=[${eventSummary}]`
          details.push(detail)
          console.error(`  MISMATCH: ${detail}`)
        }
      } catch (err: unknown) {
        failed++
        const msg = err instanceof Error ? err.message : String(err)
        details.push(`${name}: ERROR ${msg}`)
      }
    }
  } finally {
    await cleanupSandboxes(names)
  }

  console.log(`  Completed in ${elapsed(start)}: ${passed} passed, ${failed} failed`)
  return { suite, total: names.length, passed, failed, details }
}

// ---------------------------------------------------------------------------
// Suite 5: Status distribution analysis
// ---------------------------------------------------------------------------
async function suiteStatusDistribution(): Promise<TestResult> {
  const suite = "status-distribution"
  console.log(`\n${"=".repeat(70)}`)
  console.log(`SUITE: ${suite} — Create ${TOTAL} sandboxes, analyze status distribution`)
  console.log(`${"=".repeat(70)}`)

  const names: string[] = []
  const details: string[] = []
  let passed = 0
  let failed = 0
  const start = Date.now()

  type StatusSnapshot = {
    name: string
    listStatus: string
    getStatus: string
    eventCount: number
    lastEventStatus: string
    lastEventTime: string
    timeSinceCreate: number
  }
  const snapshots: StatusSnapshot[] = []

  try {
    // Create sandboxes
    const createStart = Date.now()
    const indices = Array.from({ length: TOTAL }, (_, i) => i)
    await runPool(indices, PARALLEL, async (_, i) => {
      const name = uniqueName("dist")
      names.push(name)
      await SandboxInstance.create({ name, image: IMAGE, labels: LABELS, memory: 2048 })
      if ((i + 1) % 10 === 0) console.log(`  Created ${i + 1}/${TOTAL}`)
    })
    const createDuration = Date.now() - createStart
    console.log(`  All ${TOTAL} created in ${(createDuration / 1000).toFixed(1)}s`)

    // Wait for settlement
    console.log("  Waiting for all to reach terminal status...")
    await runPool([...names], PARALLEL, async (name) => {
      await waitForStatus(name, ["DEPLOYED", "FAILED", "TERMINATED"])
    })
    await sleep(5000)

    // Snapshot: list + get for each
    console.log("  Taking list+get snapshot...")
    const allListed = await SandboxInstance.list()
    const listedByName = new Map<string, SandboxInstance>()
    for (const sbx of allListed) {
      if (names.includes(sbx.metadata?.name ?? "")) {
        listedByName.set(sbx.metadata!.name!, sbx)
      }
    }

    await runPool([...names], PARALLEL, async (name) => {
      try {
        const listed = listedByName.get(name)
        const listStatus = listed?.status ?? "NOT_IN_LIST"
        const got = await SandboxInstance.get(name)
        const getStatus = got.status ?? "UNKNOWN"
        const events = (got.events ?? []) as { status?: string; time?: string }[]
        const lastEvent = events.length > 0 ? events[events.length - 1] : null
        const createdAt = got.metadata?.createdAt
          ? new Date(got.metadata.createdAt).getTime()
          : Date.now()

        snapshots.push({
          name,
          listStatus,
          getStatus,
          eventCount: events.length,
          lastEventStatus: lastEvent?.status ?? "NONE",
          lastEventTime: lastEvent?.time ?? "",
          timeSinceCreate: Date.now() - createdAt,
        })

        if (listStatus === getStatus) {
          passed++
        } else {
          failed++
          details.push(`${name}: list=${listStatus} get=${getStatus}`)
        }
      } catch (err: unknown) {
        failed++
        const msg = err instanceof Error ? err.message : String(err)
        details.push(`${name}: ERROR ${msg}`)
      }
    })

    // Print analysis
    console.log(`\n  --- Status Distribution ---`)

    const listCounts = new Map<string, number>()
    const getCounts = new Map<string, number>()
    const eventCountDist = new Map<number, number>()

    for (const s of snapshots) {
      listCounts.set(s.listStatus, (listCounts.get(s.listStatus) || 0) + 1)
      getCounts.set(s.getStatus, (getCounts.get(s.getStatus) || 0) + 1)
      eventCountDist.set(s.eventCount, (eventCountDist.get(s.eventCount) || 0) + 1)
    }

    console.log(`\n  List endpoint statuses:`)
    for (const [status, count] of [...listCounts.entries()].sort()) {
      console.log(`    ${status.padEnd(15)} ${String(count).padStart(4)} (${((count / snapshots.length) * 100).toFixed(1)}%)`)
    }

    console.log(`\n  Get endpoint statuses:`)
    for (const [status, count] of [...getCounts.entries()].sort()) {
      console.log(`    ${status.padEnd(15)} ${String(count).padStart(4)} (${((count / snapshots.length) * 100).toFixed(1)}%)`)
    }

    console.log(`\n  Event count distribution:`)
    for (const [count, freq] of [...eventCountDist.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`    ${count} events: ${freq} sandboxes`)
    }

    if (failed > 0) {
      console.log(`\n  Mismatches (list != get):`)
      for (const d of details) {
        console.log(`    ${d}`)
      }
    }
  } finally {
    await cleanupSandboxes(names)
  }

  console.log(`  Completed in ${elapsed(start)}: ${passed} passed, ${failed} failed`)
  return { suite, total: names.length, passed, failed, details }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2)
  const suiteArg = args.find((a) => a.startsWith("--suite="))?.split("=")[1] ?? "all"

  const suites: Record<string, () => Promise<TestResult>> = {
    rapid: suiteRapidCreation,
    "delete-race": suiteDeleteRace,
    update: suiteUpdateAfterDeploy,
    concurrent: suiteConcurrentBurst,
    distribution: suiteStatusDistribution,
  }

  console.log(`\nSandbox Status Race Condition Test`)
  console.log(`  Suite:    ${suiteArg}`)
  console.log(`  Total:    ${TOTAL} per suite`)
  console.log(`  Parallel: ${PARALLEL}`)
  console.log(`  Poll:     ${POLL_MS}ms interval, ${POLL_MAX_MS}ms max`)

  const results: TestResult[] = []

  if (suiteArg === "all") {
    for (const [name, fn] of Object.entries(suites)) {
      console.log(`\nRunning suite: ${name}`)
      results.push(await fn())
    }
  } else if (suites[suiteArg]) {
    results.push(await suites[suiteArg]())
  } else {
    console.error(`Unknown suite: ${suiteArg}. Available: ${Object.keys(suites).join(", ")}, all`)
    process.exit(1)
  }

  // Final report
  console.log(`\n${"=".repeat(70)}`)
  console.log("FINAL REPORT")
  console.log(`${"=".repeat(70)}`)
  console.log(`  ${"SUITE".padEnd(25)} ${"TOTAL".padStart(6)} ${"PASS".padStart(6)} ${"FAIL".padStart(6)} ${"RATE".padStart(8)}`)
  console.log(`  ${"-".repeat(25)} ${"-".repeat(6)} ${"-".repeat(6)} ${"-".repeat(6)} ${"-".repeat(8)}`)

  let totalPassed = 0
  let totalFailed = 0

  for (const r of results) {
    const rate = r.total > 0 ? `${((r.passed / r.total) * 100).toFixed(1)}%` : "N/A"
    console.log(`  ${r.suite.padEnd(25)} ${String(r.total).padStart(6)} ${String(r.passed).padStart(6)} ${String(r.failed).padStart(6)} ${rate.padStart(8)}`)
    totalPassed += r.passed
    totalFailed += r.failed
  }

  const totalRate = totalPassed + totalFailed > 0
    ? `${((totalPassed / (totalPassed + totalFailed)) * 100).toFixed(1)}%`
    : "N/A"
  console.log(`  ${"-".repeat(25)} ${"-".repeat(6)} ${"-".repeat(6)} ${"-".repeat(6)} ${"-".repeat(8)}`)
  console.log(`  ${"TOTAL".padEnd(25)} ${String(totalPassed + totalFailed).padStart(6)} ${String(totalPassed).padStart(6)} ${String(totalFailed).padStart(6)} ${totalRate.padStart(8)}`)

  console.log()

  if (totalFailed > 0) {
    console.error(`FAILED: ${totalFailed} sandbox(es) had status mismatches or errors.`)
    console.error("The denormalized ComputedStatus is not consistent with event-computed status.")
    process.exit(1)
  }

  console.log("PASSED: All sandbox statuses are consistent across list and get endpoints.")
  process.exit(0)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
