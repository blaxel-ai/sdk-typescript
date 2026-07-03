/**
 * Transient-failure reproducer — integration test against the real Blaxel API.
 *
 * Reproduces three customer-facing transient failures observed in production:
 *
 *   1. "vanished" status on concurrent createIfNotExists — firing N concurrent
 *      SandboxInstance.createIfNotExists() for the SAME name makes one call win
 *      the creation lock while the others get 409 (lock held) + 404 on get (row
 *      not written yet) = "vanished". The SDK only retries 3x500ms = 1.5s before
 *      throwing "Unable to create sandbox after 3 attempts. Last conflicting
 *      status: vanished."
 *
 *   2. WORKLOAD_UNAVAILABLE 404 — the gateway returns a 404 (often with
 *      retryable: true) when the sandbox record exists but has no healthy pod
 *      yet (still spinning up, or just woken from standby). Hammering process
 *      operations right after create()/wake catches it.
 *
 *   3. 504 Gateway Timeout on long creation — a stuck workload can make creation
 *      exceed CloudFront's 60s limit, surfacing as a 504 in prod. We measure
 *      full create response time and flag anything over the threshold.
 *
 * Usage:
 *   npx tsx tests/manual/reproduce_transient_failures.ts --suite=vanished
 *   npx tsx tests/manual/reproduce_transient_failures.ts --suite=unavailable
 *   npx tsx tests/manual/reproduce_transient_failures.ts --suite=timeout
 *   npx tsx tests/manual/reproduce_transient_failures.ts --suite=all
 *
 * Environment variables:
 *   VANISHED_CONCURRENCY    Concurrent createIfNotExists per name (default: 10)
 *   VANISHED_ROUNDS         Rounds with different names (default: 5)
 *   UNAVAILABLE_SANDBOXES   Sandboxes created for suite 2 (default: 5)
 *   UNAVAILABLE_RAPID_CALLS Rapid process calls per sandbox (default: 20)
 *   TIMEOUT_SANDBOXES       Sandboxes created for suite 3 (default: 10)
 *   TIMEOUT_THRESHOLD_MS    Response time considered a 504 risk (default: 60000)
 *
 * Requires BL_WORKSPACE and BL_API_KEY (or a logged-in bl CLI).
 *
 * Exit code: 1 if any targeted issue was reproduced/detected, 0 if clean.
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
const VANISHED_CONCURRENCY = parseInt(process.env.VANISHED_CONCURRENCY || "10", 10)
const VANISHED_ROUNDS = parseInt(process.env.VANISHED_ROUNDS || "5", 10)
const UNAVAILABLE_SANDBOXES = parseInt(process.env.UNAVAILABLE_SANDBOXES || "5", 10)
const UNAVAILABLE_RAPID_CALLS = parseInt(process.env.UNAVAILABLE_RAPID_CALLS || "20", 10)
const TIMEOUT_SANDBOXES = parseInt(process.env.TIMEOUT_SANDBOXES || "10", 10)
const TIMEOUT_THRESHOLD_MS = parseInt(process.env.TIMEOUT_THRESHOLD_MS || "60000", 10)

const CLEANUP_PARALLEL = parseInt(process.env.CLEANUP_PARALLEL || "10", 10)
const IMAGE = "blaxel/base-image:latest"
const LABEL_KEY = "created-by"
const LABEL_VALUE = "transient-failures-test"
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

/** Extract a plain message + best-effort raw body from any thrown error. */
function describeError(err: unknown): { message: string; raw: string } {
  if (err instanceof Error) {
    return { message: err.message, raw: err.message }
  }
  if (typeof err === "object" && err !== null) {
    try {
      const json = JSON.stringify(err)
      return { message: json, raw: json }
    } catch {
      return { message: "[unserializable object]", raw: "[unserializable object]" }
    }
  }
  const str = typeof err === "string" ? err : `[${typeof err}]`
  return { message: str, raw: str }
}

function isVanishedError(err: unknown): boolean {
  const { message } = describeError(err)
  return /vanished/i.test(message) || /Unable to create sandbox after/i.test(message)
}

function isWorkloadUnavailableError(err: unknown): boolean {
  const { message } = describeError(err)
  return (
    /WORKLOAD_UNAVAILABLE/i.test(message) ||
    /not available/i.test(message) ||
    /no healthy/i.test(message) ||
    /no.*upstream/i.test(message)
  )
}

function hasRetryableFlag(err: unknown): boolean {
  const { message } = describeError(err)
  return /"retryable"\s*:\s*true/i.test(message) || /retryable/i.test(message)
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
  const unique = [...new Set(names)]
  if (unique.length === 0) return
  console.log(`  Cleaning up ${unique.length} sandboxes...`)
  await runPool(unique, CLEANUP_PARALLEL, async (name) => {
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
  // `reproduced` is the number of targeted transient failures observed.
  reproduced: number
  // total attempts made (for context in the report)
  attempts: number
  // whether the suite considers the run "issue detected" (non-zero exit)
  issueDetected: boolean
  details: string[]
}

// ---------------------------------------------------------------------------
// Suite 1: Reproduce "vanished" status via concurrent createIfNotExists
// ---------------------------------------------------------------------------
async function suiteVanished(): Promise<TestResult> {
  const suite = "vanished"
  console.log(`\n${"=".repeat(70)}`)
  console.log(`SUITE: ${suite} — concurrent createIfNotExists() on the SAME name`)
  console.log(`  Concurrency: ${VANISHED_CONCURRENCY} calls/name, Rounds: ${VANISHED_ROUNDS}`)
  console.log(`${"=".repeat(70)}`)

  const names: string[] = []
  const details: string[] = []
  let reproduced = 0
  let attempts = 0
  let succeeded = 0
  const start = Date.now()

  try {
    for (let round = 0; round < VANISHED_ROUNDS; round++) {
      const name = uniqueName("vanish")
      names.push(name)
      console.log(`\n  Round ${round + 1}/${VANISHED_ROUNDS}: firing ${VANISHED_CONCURRENCY} createIfNotExists for '${name}'`)

      const roundStart = Date.now()
      const results = await Promise.all(
        Array.from({ length: VANISHED_CONCURRENCY }, async (_, i) => {
          attempts++
          const callStart = Date.now()
          try {
            const sbx = await SandboxInstance.createIfNotExists({ name, image: IMAGE, labels: LABELS, memory: 2048 })
            return { i, ok: true as const, ms: Date.now() - callStart, status: sbx.status }
          } catch (err) {
            return { i, ok: false as const, ms: Date.now() - callStart, err }
          }
        }),
      )

      let roundVanished = 0
      let roundOk = 0
      for (const r of results) {
        if (r.ok) {
          roundOk++
          succeeded++
          console.log(`    call#${r.i} OK in ${r.ms}ms (status=${r.status ?? "?"})`)
        } else {
          const { message, raw } = describeError(r.err)
          if (isVanishedError(r.err)) {
            roundVanished++
            reproduced++
            console.error(`    call#${r.i} VANISHED in ${r.ms}ms: ${message}`)
            details.push(`round${round + 1} call#${r.i}: ${message}`)
          } else {
            console.error(`    call#${r.i} FAILED (other) in ${r.ms}ms: ${message}`)
            details.push(`round${round + 1} call#${r.i} (other): ${raw}`)
          }
        }
      }
      console.log(`  Round ${round + 1} done in ${elapsed(roundStart)}: ${roundOk} ok, ${roundVanished} vanished`)
    }
  } finally {
    await cleanupSandboxes(names)
  }

  const issueDetected = reproduced > 0
  console.log(`\n  Completed in ${elapsed(start)}: ${attempts} attempts, ${succeeded} ok, ${reproduced} vanished`)
  if (issueDetected) {
    console.log(`  >>> REPRODUCED 'vanished' ${reproduced} time(s).`)
  } else {
    console.log(`  No 'vanished' errors observed this run (race did not trigger).`)
  }
  return { suite, reproduced, attempts, issueDetected, details }
}

// ---------------------------------------------------------------------------
// Suite 2: Reproduce WORKLOAD_UNAVAILABLE 404
// ---------------------------------------------------------------------------
async function suiteUnavailable(): Promise<TestResult> {
  const suite = "unavailable"
  console.log(`\n${"=".repeat(70)}`)
  console.log(`SUITE: ${suite} — hammer process ops right after create() (pre-ready)`)
  console.log(`  Sandboxes: ${UNAVAILABLE_SANDBOXES}, Rapid calls/sandbox: ${UNAVAILABLE_RAPID_CALLS}`)
  console.log(`${"=".repeat(70)}`)

  const names: string[] = []
  const details: string[] = []
  let reproduced = 0
  let attempts = 0
  let retryableSeen = 0
  const start = Date.now()

  try {
    for (let s = 0; s < UNAVAILABLE_SANDBOXES; s++) {
      const name = uniqueName("unavail")
      names.push(name)
      console.log(`\n  [${s + 1}/${UNAVAILABLE_SANDBOXES}] Creating '${name}' (raw create, not waiting for ready)`)

      let sbx: SandboxInstance
      try {
        // Raw create — returns before the workload is fully ready.
        sbx = await SandboxInstance.create({ name, image: IMAGE, labels: LABELS, memory: 2048 })
      } catch (err) {
        const { message, raw } = describeError(err)
        console.error(`    create failed: ${message}`)
        details.push(`${name}: create failed: ${raw}`)
        if (isWorkloadUnavailableError(err)) reproduced++
        continue
      }

      // Immediately hammer process ops before the workload is ready.
      console.log(`    hammering ${UNAVAILABLE_RAPID_CALLS} rapid process calls...`)
      let sandboxReproduced = 0
      for (let c = 0; c < UNAVAILABLE_RAPID_CALLS; c++) {
        attempts++
        const callStart = Date.now()
        try {
          // Alternate between exec (POST) and process.get (GET) to exercise both paths.
          if (c % 2 === 0) {
            await sbx.process.exec({ command: "echo ready" })
          } else {
            await sbx.process.get(`nonexistent-${uuidv4().substring(0, 8)}`)
          }
        } catch (err) {
          const { message, raw } = describeError(err)
          if (isWorkloadUnavailableError(err)) {
            sandboxReproduced++
            reproduced++
            const retryable = hasRetryableFlag(err)
            if (retryable) retryableSeen++
            console.error(`      call#${c} WORKLOAD_UNAVAILABLE in ${Date.now() - callStart}ms (retryable=${retryable})`)
            console.error(`        raw: ${raw}`)
            details.push(`${name} call#${c}: ${raw}`)
          } else {
            // A 404 for a nonexistent pid is expected once the workload IS ready —
            // that means we lost the race window; log at low volume.
            if (c < 2 || /WORKLOAD/i.test(message)) {
              console.log(`      call#${c} other error in ${Date.now() - callStart}ms: ${message}`)
            }
          }
        }
      }
      console.log(`    '${name}': ${sandboxReproduced} WORKLOAD_UNAVAILABLE caught`)

      // Second angle: put to sleep then wake and immediately hit it.
      try {
        console.log(`    testing wake-from-standby window...`)
        // Best-effort: not all deployments expose an explicit sleep; connecting
        // right after a brief idle can still catch the wake window.
        await sleep(2000)
        const woke = await SandboxInstance.get(name)
        const wakeStart = Date.now()
        try {
          await woke.process.exec({ command: "echo woke" })
        } catch (err) {
          if (isWorkloadUnavailableError(err)) {
            reproduced++
            const retryable = hasRetryableFlag(err)
            if (retryable) retryableSeen++
            const { raw } = describeError(err)
            console.error(`      wake WORKLOAD_UNAVAILABLE in ${Date.now() - wakeStart}ms (retryable=${retryable}): ${raw}`)
            details.push(`${name} wake: ${raw}`)
          }
        }
      } catch {
        // ignore standby probing errors
      }
    }
  } finally {
    await cleanupSandboxes(names)
  }

  const issueDetected = reproduced > 0
  console.log(`\n  Completed in ${elapsed(start)}: ${attempts} process calls, ${reproduced} WORKLOAD_UNAVAILABLE (retryable=true on ${retryableSeen})`)
  if (issueDetected) {
    console.log(`  >>> REPRODUCED WORKLOAD_UNAVAILABLE ${reproduced} time(s).`)
  } else {
    console.log(`  No WORKLOAD_UNAVAILABLE observed (workloads became ready fast enough).`)
  }
  return { suite, reproduced, attempts, issueDetected, details }
}

// ---------------------------------------------------------------------------
// Suite 3: Reproduce 504 Gateway Timeout (long creation)
// ---------------------------------------------------------------------------
async function suiteTimeout(): Promise<TestResult> {
  const suite = "timeout"
  console.log(`\n${"=".repeat(70)}`)
  console.log(`SUITE: ${suite} — measure create() latency, flag > ${TIMEOUT_THRESHOLD_MS}ms (CloudFront 504 risk)`)
  console.log(`  Sandboxes: ${TIMEOUT_SANDBOXES}`)
  console.log(`${"=".repeat(70)}`)

  const names: string[] = []
  const details: string[] = []
  let reproduced = 0
  let attempts = 0
  const durations: number[] = []
  const start = Date.now()

  try {
    for (let s = 0; s < TIMEOUT_SANDBOXES; s++) {
      const name = uniqueName("timeout")
      names.push(name)
      attempts++
      const callStart = Date.now()
      try {
        await SandboxInstance.create({ name, image: IMAGE, labels: LABELS, memory: 2048 })
        const ms = Date.now() - callStart
        durations.push(ms)
        const flag = ms > TIMEOUT_THRESHOLD_MS ? " >>> OVER THRESHOLD (would 504 via CloudFront)" : ""
        console.log(`  [${s + 1}/${TIMEOUT_SANDBOXES}] '${name}' created in ${ms}ms${flag}`)
        if (ms > TIMEOUT_THRESHOLD_MS) {
          reproduced++
          details.push(`${name}: create took ${ms}ms (> ${TIMEOUT_THRESHOLD_MS}ms)`)
        }
      } catch (err) {
        const ms = Date.now() - callStart
        const { message, raw } = describeError(err)
        durations.push(ms)
        const is504 = /504/.test(message) || /gateway ?time-?out/i.test(message) || /timeout/i.test(message)
        console.error(`  [${s + 1}/${TIMEOUT_SANDBOXES}] '${name}' failed after ${ms}ms: ${message}`)
        if (is504 || ms > TIMEOUT_THRESHOLD_MS) {
          reproduced++
          details.push(`${name}: create errored after ${ms}ms: ${raw}`)
        }
      }
    }
  } finally {
    await cleanupSandboxes(names)
  }

  if (durations.length > 0) {
    const sorted = [...durations].sort((a, b) => a - b)
    const sum = sorted.reduce((a, b) => a + b, 0)
    const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
    console.log(`\n  create() latency (ms): min=${sorted[0]} p50=${p(0.5)} p95=${p(0.95)} max=${sorted[sorted.length - 1]} avg=${Math.round(sum / sorted.length)}`)
  }

  const issueDetected = reproduced > 0
  console.log(`  Completed in ${elapsed(start)}: ${attempts} creates, ${reproduced} over ${TIMEOUT_THRESHOLD_MS}ms`)
  if (issueDetected) {
    console.log(`  >>> DETECTED ${reproduced} creation(s) that would risk a 504.`)
  } else {
    console.log(`  No creation exceeded ${TIMEOUT_THRESHOLD_MS}ms.`)
  }
  return { suite, reproduced, attempts, issueDetected, details }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2)
  const suiteArg = args.find((a) => a.startsWith("--suite="))?.split("=")[1] ?? "all"

  const suites: Record<string, () => Promise<TestResult>> = {
    vanished: suiteVanished,
    unavailable: suiteUnavailable,
    timeout: suiteTimeout,
  }

  console.log(`\nTransient Failures Reproducer`)
  console.log(`  Suite:     ${suiteArg}`)
  console.log(`  Workspace: ${process.env.BL_WORKSPACE ?? "(from bl CLI)"}`)

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
  console.log(`  ${"SUITE".padEnd(15)} ${"ATTEMPTS".padStart(9)} ${"REPRODUCED".padStart(11)} ${"STATUS".padStart(14)}`)
  console.log(`  ${"-".repeat(15)} ${"-".repeat(9)} ${"-".repeat(11)} ${"-".repeat(14)}`)

  let anyIssue = false
  for (const r of results) {
    const status = r.issueDetected ? "REPRODUCED" : "not triggered"
    console.log(`  ${r.suite.padEnd(15)} ${String(r.attempts).padStart(9)} ${String(r.reproduced).padStart(11)} ${status.padStart(14)}`)
    if (r.issueDetected) anyIssue = true
  }

  for (const r of results) {
    if (r.details.length > 0) {
      console.log(`\n  --- ${r.suite} details (${r.details.length}) ---`)
      for (const d of r.details.slice(0, 50)) {
        console.log(`    ${d}`)
      }
      if (r.details.length > 50) {
        console.log(`    ... and ${r.details.length - 50} more`)
      }
    }
  }

  console.log()
  if (anyIssue) {
    console.error("ISSUE(S) REPRODUCED: at least one transient failure was observed. See details above.")
    process.exit(1)
  }
  console.log("CLEAN: no targeted transient failures were reproduced this run.")
  process.exit(0)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
