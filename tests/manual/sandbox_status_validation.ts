/**
 * Validates that the sandbox list endpoint returns the correct status
 * after creation, by comparing list vs get for each sandbox.
 *
 * This catches the race condition where the denormalized ComputedStatus
 * (used by list) shows DEPLOYING while the event-computed status (used
 * by get) correctly shows DEPLOYED.
 *
 * Usage:
 *   npx tsx tests/manual/sandbox_status_validation.ts
 *
 * Environment variables:
 *   TOTAL        Number of sandboxes to create (default: 100)
 *   PARALLEL     Concurrency limit for creation (default: 10)
 *   WAIT_MS      Delay after creation before checking status (default: 5000)
 *   POLL_MS      Interval for polling sandbox readiness (default: 1000)
 *   POLL_MAX_MS  Max time to wait for DEPLOYED status via get (default: 60000)
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

const TOTAL = parseInt(process.env.TOTAL || "100", 10)
const PARALLEL = parseInt(process.env.PARALLEL || "10", 10)
const WAIT_MS = parseInt(process.env.WAIT_MS || "5000", 10)
const POLL_MS = parseInt(process.env.POLL_MS || "1000", 10)
const POLL_MAX_MS = parseInt(process.env.POLL_MAX_MS || "60000", 10)
const IMAGE = "blaxel/base-image:latest"
const LABEL_KEY = "created-by"
const LABEL_VALUE = "status-validation-test"
const LABELS: Record<string, string> = {
  env: "manual-test",
  [LABEL_KEY]: LABEL_VALUE,
}

type SandboxResult = {
  name: string
  listStatus: string
  getStatus: string
  lastEventStatus: string
  match: boolean
  error?: string
}

function uniqueName(): string {
  return `sv-${uuidv4().replace(/-/g, "").substring(0, 8)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForDeployed(name: string): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < POLL_MAX_MS) {
    try {
      const sbx = await SandboxInstance.get(name)
      const status = sbx.status ?? "UNKNOWN"
      if (status === "DEPLOYED" || status === "FAILED" || status === "TERMINATED") {
        return status
      }
    } catch {
      // sandbox may not be queryable yet
    }
    await sleep(POLL_MS)
  }
  return "TIMEOUT"
}

async function createOne(index: number): Promise<string> {
  const name = uniqueName()
  const tag = `[${index + 1}/${TOTAL}]`
  console.log(`${tag} Creating ${name}...`)
  await SandboxInstance.create({ name, image: IMAGE, labels: LABELS, memory: 2048 })
  console.log(`${tag} Created  ${name}`)
  return name
}

async function main() {
  console.log(`\nSandbox Status Validation Test`)
  console.log(`  Total:    ${TOTAL}`)
  console.log(`  Parallel: ${PARALLEL}`)
  console.log(`  Wait:     ${WAIT_MS}ms (after creation, before validation)`)
  console.log(`  Poll:     ${POLL_MS}ms interval, ${POLL_MAX_MS}ms max`)
  console.log()

  // Phase 1: Create sandboxes with concurrency limit
  const names: string[] = []
  const queue = Array.from({ length: TOTAL }, (_, i) => i)

  async function createWorker() {
    while (queue.length > 0) {
      const index = queue.shift()!
      const name = await createOne(index)
      names.push(name)
    }
  }

  const createWorkers = Array.from({ length: Math.min(PARALLEL, TOTAL) }, () => createWorker())
  await Promise.all(createWorkers)

  console.log(`\nAll ${names.length} sandboxes created. Waiting for deployments to settle...`)

  const results: SandboxResult[] = []
  let exitCode = 0

  try {
    // Phase 2: Wait for all sandboxes to reach DEPLOYED via get (event-computed)
    const deployedStatuses = new Map<string, string>()
    const pollQueue = [...names]

    async function pollWorker() {
      while (pollQueue.length > 0) {
        const name = pollQueue.shift()!
        const status = await waitForDeployed(name)
        deployedStatuses.set(name, status)
        if (status !== "DEPLOYED") {
          console.warn(`  WARNING: ${name} reached ${status} via get (expected DEPLOYED)`)
        }
      }
    }

    const pollWorkers = Array.from({ length: Math.min(PARALLEL, names.length) }, () => pollWorker())
    await Promise.all(pollWorkers)

    console.log(`All sandboxes polled. Waiting ${WAIT_MS}ms before validation...\n`)
    await sleep(WAIT_MS)

    // Phase 3: Fetch the full list and compare
    console.log("Fetching sandbox list...")
    const allListed = await SandboxInstance.list()
    const listedByName = new Map<string, SandboxInstance>()
    for (const sbx of allListed) {
      if (sbx.metadata?.labels?.[LABEL_KEY] === LABEL_VALUE) {
        listedByName.set(sbx.metadata.name!, sbx)
      }
    }

    // Phase 4: For each created sandbox, compare list status vs get status
    console.log("Comparing list vs get status for each sandbox...\n")
    const compareQueue = [...names]

    async function compareWorker() {
      while (compareQueue.length > 0) {
        const name = compareQueue.shift()!
        try {
          const listed = listedByName.get(name)
          const listStatus = listed?.status ?? "NOT_IN_LIST"

          const got = await SandboxInstance.get(name)
          const getStatus = got.status ?? "UNKNOWN"
          const events = got.events ?? []
          const lastEvent = events.length > 0 ? events[events.length - 1] : null
          const lastEventStatus = lastEvent?.status ?? "NO_EVENTS"

          const match = listStatus === getStatus
          results.push({ name, listStatus, getStatus, lastEventStatus, match })

          if (!match) {
            console.error(`  MISMATCH ${name}: list=${listStatus} get=${getStatus} lastEvent=${lastEventStatus}`)
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          results.push({
            name,
            listStatus: "ERROR",
            getStatus: "ERROR",
            lastEventStatus: "ERROR",
            match: false,
            error: message,
          })
          console.error(`  ERROR ${name}: ${message}`)
        }
      }
    }

    const compareWorkers = Array.from({ length: Math.min(PARALLEL, names.length) }, () => compareWorker())
    await Promise.all(compareWorkers)

    // Phase 5: Report
    console.log(`\n${"=".repeat(70)}`)
    console.log("RESULTS")
    console.log(`${"=".repeat(70)}`)

    const matched = results.filter((r) => r.match)
    const mismatched = results.filter((r) => !r.match)
    const errors = results.filter((r) => r.error)

    console.log(`  Total:      ${results.length}`)
    console.log(`  Match:      ${matched.length}`)
    console.log(`  Mismatch:   ${mismatched.length}`)
    console.log(`  Errors:     ${errors.length}`)

    if (mismatched.length > 0) {
      console.log(`\nMismatched sandboxes (list status != get status):`)
      console.log(`  ${"NAME".padEnd(30)} ${"LIST".padEnd(12)} ${"GET".padEnd(12)} LAST_EVENT`)
      console.log(`  ${"-".repeat(30)} ${"-".repeat(12)} ${"-".repeat(12)} ${"-".repeat(12)}`)
      for (const r of mismatched) {
        console.log(`  ${r.name.padEnd(30)} ${r.listStatus.padEnd(12)} ${r.getStatus.padEnd(12)} ${r.lastEventStatus}`)
      }
    }

    // Status distribution from list
    const listStatusCounts = new Map<string, number>()
    for (const r of results) {
      listStatusCounts.set(r.listStatus, (listStatusCounts.get(r.listStatus) || 0) + 1)
    }
    console.log(`\nList status distribution:`)
    for (const [status, count] of [...listStatusCounts.entries()].sort()) {
      const pct = ((count / results.length) * 100).toFixed(1)
      console.log(`  ${status.padEnd(15)} ${String(count).padStart(4)} (${pct}%)`)
    }

    // Status distribution from get
    const getStatusCounts = new Map<string, number>()
    for (const r of results) {
      getStatusCounts.set(r.getStatus, (getStatusCounts.get(r.getStatus) || 0) + 1)
    }
    console.log(`\nGet status distribution:`)
    for (const [status, count] of [...getStatusCounts.entries()].sort()) {
      const pct = ((count / results.length) * 100).toFixed(1)
      console.log(`  ${status.padEnd(15)} ${String(count).padStart(4)} (${pct}%)`)
    }

    console.log()

    if (mismatched.length > 0) {
      const mismatchPct = ((mismatched.length / results.length) * 100).toFixed(1)
      console.error(
        `FAILED: ${mismatched.length}/${results.length} (${mismatchPct}%) sandboxes have list/get status mismatch.`
      )
      console.error("The denormalized ComputedStatus is not being written correctly.")
      exitCode = 1
    }

    if (errors.length > 0) {
      console.error(`WARNING: ${errors.length} sandboxes had errors during validation.`)
      exitCode = 1
    }

    if (exitCode === 0) {
      console.log("PASSED: All sandboxes have matching list/get status.")
    }
  } finally {
    // Cleanup always runs, even on error
    console.log("\nCleaning up sandboxes...")
    const deleteQueue = [...names]

    async function deleteWorker() {
      while (deleteQueue.length > 0) {
        const name = deleteQueue.shift()!
        try {
          await SandboxInstance.delete(name)
        } catch {
          // best effort
        }
      }
    }

    const deleteWorkers = Array.from({ length: Math.min(PARALLEL, names.length) }, () => deleteWorker())
    await Promise.all(deleteWorkers)
    console.log("Cleanup complete.")
  }

  process.exit(exitCode)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
