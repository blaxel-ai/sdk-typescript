/**
 * Reproducer for Blaxel's delete-then-reuse-same-name bug.
 *
 * TypeScript port of the customer's standalone Go reproducer
 * (see attached main.go). Same flow, same assertions, same hit-classifier.
 *
 * Per trial, against the live Blaxel API:
 *
 *   1. POST   /v0/sandboxes               create sandbox NAME (createIfNotExist=true)
 *   2. POST   <metadata.url>/process      exec `echo warm`            ← polls up to ~30s
 *   3. DELETE /v0/sandboxes/NAME          destroy it                  ← returns 200
 *   3b. GET   /v0/sandboxes/NAME (loop)   poll until status=TERMINATED (or GONE/TIMEOUT)
 *       — captures the post-delete status timeline so we can tell whether
 *         we recreated too early (still DELETING) or against a real tombstone
 *         (status=TERMINATED, metadata.url dead).
 *   4. POST   /v0/sandboxes               create NAME again
 *   5. POST   <metadata.url>/process      exec `echo ok`              ← polls up to ~30s
 *
 * A trial "hits" the bug if step 4 fails with SANDBOX_ALREADY_EXISTS, OR step 5
 * keeps returning WORKLOAD_UNAVAILABLE / "Workload not found" for the whole 30s
 * readiness window. Both symptoms have the same root cause: DELETE leaves a
 * tombstone record (status=TERMINATED, state=STANDBY) whose `metadata.url` still
 * points at a workload the scheduler already tore down. A subsequent CREATE
 * under the same name either collides with the tombstone (409) or appears to
 * succeed but doesn't actually replace the dead workload (the new
 * `metadata.url` keeps 404ing for `/process` calls).
 *
 * Env:
 *   TOTAL=10                 number of trials
 *   PARALLEL=1               concurrency (customer's repro is sequential)
 *   USE_CREATE_IF_NOT_EXIST  default "true" (matches customer's behavior)
 *   READY_TIMEOUT_MS=30000   exec readiness polling window
 *   TERMINATED_TIMEOUT_MS=60000  how long to wait for status=TERMINATED after delete
 *   TERMINATED_POLL_MS=500   poll interval while waiting for TERMINATED
 *   POST_TERMINATED_WAIT_MS=0   extra delay AFTER observing TERMINATED before recreate
 *                              (try a few seconds to test if the tombstone clears)
 *   IMAGE                    sandbox image (default blaxel/base-image:latest)
 *   BL_REGION                default us-was-1
 *
 * Run:
 *   cd @blaxel/core && npm run build && cd ../..
 *   npx tsx tests/manual/recreate-same-name-tombstone.ts
 */
import { SandboxInstance, settings } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason)
})
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err)
  process.exit(1)
})

const TOTAL = parseInt(process.env.TOTAL || "10", 10)
const PARALLEL = parseInt(process.env.PARALLEL || "1", 10)
const USE_CREATE_IF_NOT_EXIST = (process.env.USE_CREATE_IF_NOT_EXIST ?? "true") === "true"
const READY_TIMEOUT_MS = parseInt(process.env.READY_TIMEOUT_MS || "30000", 10)
const TRIAL_TIMEOUT_MS = parseInt(process.env.TRIAL_TIMEOUT_MS || "180000", 10)
const TERMINATED_TIMEOUT_MS = parseInt(process.env.TERMINATED_TIMEOUT_MS || "60000", 10)
const TERMINATED_POLL_MS = parseInt(process.env.TERMINATED_POLL_MS || "500", 10)
const POST_TERMINATED_WAIT_MS = parseInt(process.env.POST_TERMINATED_WAIT_MS || "0", 10)
const IMAGE = process.env.IMAGE || "blaxel/base-image:latest"
const REGION = process.env.BL_REGION || "us-was-1"
const MEMORY_MB = parseInt(process.env.MEMORY_MB || "4096", 10)
const TTL = process.env.TTL || "1d"
const LABELS = { env: "manual-test", "created-by": "recreate-tombstone-repro" }

const BUG_MARKERS = ["WORKLOAD_UNAVAILABLE", "SANDBOX_ALREADY_EXISTS", "Workload not found"]

type Outcome = "OK" | "BUG" | "FAIL"

type TrialResult = {
  index: number
  name: string
  outcome: Outcome
  marker?: string
  detail?: string
  timings: {
    create?: number
    warmExec?: number
    delete?: number
    awaitTerminated?: number
    recreate?: number
    recreateExec?: number
  }
  warmUrl?: string
  recreateUrl?: string
  recreateAttempts?: number
  postDeleteStatusTimeline?: Array<{ tMs: number; status: string }>
  statusAtRecreate?: string
}

class HttpError extends Error {
  constructor(public status: number, public bodyText: string, public method: string, public url: string) {
    super(`HTTP ${status} ${method} ${url}: ${bodyText.slice(0, 300)}`)
  }
}

function freshName(): string {
  return `repro-${uuidv4().replace(/-/g, "").substring(0, 16)}`
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(t)
      reject(new Error("aborted"))
    }, { once: true })
  })
}

function matchesBug(text: string): string | null {
  for (const marker of BUG_MARKERS) if (text.includes(marker)) return marker
  return null
}

function baseUrlFor(sbx: SandboxInstance, name: string): string {
  return sbx.metadata.url ?? `${settings.runUrl}/${settings.workspace}/sandboxes/${name}`
}

async function execOnce(sandboxUrl: string, command: string, ctx: AbortSignal): Promise<void> {
  const url = `${sandboxUrl}/process`
  const res = await globalThis.fetch(url, {
    method: "POST",
    headers: { ...settings.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ command, waitForCompletion: true, timeout: 30 }),
    signal: ctx,
  })
  const body = await res.text()
  if (res.status >= 400) throw new HttpError(res.status, body, "POST", url)
}

/**
 * Polls /process for up to READY_TIMEOUT_MS, matching the customer's
 * `execWithReady`. The Blaxel API's own WORKLOAD_UNAVAILABLE response instructs
 * callers to retry 500ms → 30s; if the bug still surfaces after that window,
 * the workload is permanently dead (tombstone), not just cold.
 */
async function execWithReady(sandboxUrl: string, command: string, ctx: AbortSignal): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let lastErr: unknown
  for (;;) {
    try {
      await execOnce(sandboxUrl, command, ctx)
      return
    } catch (err) {
      lastErr = err
      if (Date.now() > deadline) throw err
      if (ctx.aborted) throw err
      await sleep(500, ctx)
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-unreachable
  throw lastErr
}

type AwaitTerminatedResult = {
  finalStatus: "TERMINATED" | "GONE" | "TIMEOUT"
  timeline: Array<{ tMs: number; status: string }>
  durationMs: number
}

/**
 * Polls the control plane after DELETE and records the status transitions.
 * Returns when the sandbox is either:
 *   - reported as TERMINATED, or
 *   - 404 (GONE — the record has been cleaned up entirely), or
 *   - TERMINATED_TIMEOUT_MS has elapsed (TIMEOUT — usually means stuck in
 *     DELETING / DEACTIVATING).
 *
 * The customer's case showed DELETED -> TERMINATED in ~3.3s, and the recreate
 * that hit the tombstone happened ~1.6s after that. Capturing the timeline
 * lets us correlate "did we recreate too early" vs "the tombstone is real".
 */
async function awaitTerminated(name: string, ctx: AbortSignal): Promise<AwaitTerminatedResult> {
  const start = Date.now()
  const deadline = start + TERMINATED_TIMEOUT_MS
  const timeline: Array<{ tMs: number; status: string }> = []
  let lastSeen = ""

  for (;;) {
    if (ctx.aborted) {
      return { finalStatus: "TIMEOUT", timeline, durationMs: Date.now() - start }
    }
    let status = ""
    let gone = false
    try {
      const sbx = await SandboxInstance.get(name)
      status = sbx.status ?? "UNKNOWN"
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown }
      const msg = typeof e.message === "string" ? e.message : ""
      if (e.code === 404 || msg.includes("status code 404") || msg.includes("not found")) {
        gone = true
      } else {
        status = `ERR(${msg.slice(0, 80)})`
      }
    }

    if (gone) {
      timeline.push({ tMs: Date.now() - start, status: "GONE" })
      return { finalStatus: "GONE", timeline, durationMs: Date.now() - start }
    }
    if (status && status !== lastSeen) {
      timeline.push({ tMs: Date.now() - start, status })
      lastSeen = status
    }
    if (status === "TERMINATED") {
      return { finalStatus: "TERMINATED", timeline, durationMs: Date.now() - start }
    }
    if (Date.now() > deadline) {
      return { finalStatus: "TIMEOUT", timeline, durationMs: Date.now() - start }
    }
    await sleep(TERMINATED_POLL_MS, ctx).catch(() => undefined)
  }
}

async function createOnce(name: string): Promise<SandboxInstance> {
  return await SandboxInstance.create(
    {
      name,
      image: IMAGE,
      labels: LABELS,
      memory: MEMORY_MB,
      region: REGION,
      ttl: TTL,
      ports: [{ name: "sandbox-api", protocol: "HTTP", target: 8080 }],
    },
    USE_CREATE_IF_NOT_EXIST ? { createIfNotExist: true } : undefined
  )
}

function isAlreadyExistsError(err: unknown): { is: boolean; marker?: string } {
  if (typeof err !== "object" || err === null) return { is: false }
  const e = err as { code?: unknown; message?: unknown }
  const msg = typeof e.message === "string" ? e.message : ""
  if (e.code === 409 || msg.includes("status code 409")) return { is: true, marker: "SANDBOX_ALREADY_EXISTS" }
  if (typeof e.code === "string" && e.code === "SANDBOX_ALREADY_EXISTS") return { is: true, marker: "SANDBOX_ALREADY_EXISTS" }
  const m = matchesBug(msg)
  if (m === "SANDBOX_ALREADY_EXISTS") return { is: true, marker: m }
  return { is: false }
}

async function safeDelete(name: string): Promise<void> {
  try {
    await SandboxInstance.delete(name)
  } catch {
    // already gone / racing — ignore
  }
}

async function trial(index: number): Promise<TrialResult> {
  const name = freshName()
  const tag = `[${String(index + 1).padStart(2, " ")}/${TOTAL} ${name}]`
  const ctrl = new AbortController()
  const trialTimer = setTimeout(() => ctrl.abort(), TRIAL_TIMEOUT_MS)
  const timings: TrialResult["timings"] = {}

  const finish = (r: TrialResult): TrialResult => {
    clearTimeout(trialTimer)
    return r
  }

  // 1. Create
  let first: SandboxInstance
  try {
    const t0 = Date.now()
    first = await createOnce(name)
    timings.create = Date.now() - t0
    console.log(`${tag} created in ${timings.create}ms`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`${tag} FAIL initial create: ${detail}`)
    return finish({ index, name, outcome: "FAIL", detail: `initial create: ${detail}`, timings })
  }
  const warmUrl = baseUrlFor(first, name)

  // 2. Warm exec (poll up to 30s — brand-new sandbox briefly 404s while booting)
  try {
    const t0 = Date.now()
    await execWithReady(warmUrl, "echo warm", ctrl.signal)
    timings.warmExec = Date.now() - t0
    console.log(`${tag} warm exec ok in ${timings.warmExec}ms`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`${tag} FAIL warm exec: ${detail}`)
    await safeDelete(name)
    return finish({ index, name, outcome: "FAIL", detail: `warm exec: ${detail}`, timings, warmUrl })
  }

  // 3. Destroy
  try {
    const t0 = Date.now()
    await first.delete()
    timings.delete = Date.now() - t0
    console.log(`${tag} destroyed in ${timings.delete}ms`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`${tag} FAIL destroy: ${detail}`)
    return finish({ index, name, outcome: "FAIL", detail: `destroy: ${detail}`, timings, warmUrl })
  }

  // 3b. Poll the control plane until the sandbox is reported as TERMINATED (or
  // GONE / TIMEOUT). This lets us correlate the symptom with the observed
  // post-delete state, and matches what the customer's transcript described:
  //   DELETED at 02:02:08.635 -> TERMINATED at 02:02:11.958 (~3.3s)
  //   then recreate fired ~1.6s after TERMINATED -> tombstone hit.
  const awaitT = await awaitTerminated(name, ctrl.signal)
  timings.awaitTerminated = awaitT.durationMs
  const timelineStr = awaitT.timeline.map((t) => `${t.status}@${t.tMs}ms`).join(" -> ")
  console.log(`${tag} post-delete: ${awaitT.finalStatus} after ${awaitT.durationMs}ms (${timelineStr || "no observed transitions"})`)

  if (POST_TERMINATED_WAIT_MS > 0 && awaitT.finalStatus === "TERMINATED") {
    console.log(`${tag} waiting ${POST_TERMINATED_WAIT_MS}ms after TERMINATED before recreate`)
    await sleep(POST_TERMINATED_WAIT_MS, ctrl.signal).catch(() => undefined)
  }

  const statusAtRecreate = awaitT.finalStatus

  // 4. Recreate under THE SAME name
  let second: SandboxInstance
  let recreateAttempts = 0
  try {
    const t0 = Date.now()
    recreateAttempts = 1
    second = await createOnce(name)
    timings.recreate = Date.now() - t0
    console.log(`${tag} recreated in ${timings.recreate}ms (statusAtRecreate=${statusAtRecreate})`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const { is, marker } = isAlreadyExistsError(err)
    if (is) {
      console.error(`${tag} BUG recreate hit ${marker}: ${detail}`)
      await safeDelete(name)
      return finish({ index, name, outcome: "BUG", marker, detail: `recreate: ${detail}`, timings, warmUrl, recreateAttempts, postDeleteStatusTimeline: awaitT.timeline, statusAtRecreate })
    }
    console.error(`${tag} FAIL recreate: ${detail}`)
    await safeDelete(name)
    return finish({ index, name, outcome: "FAIL", detail: `recreate: ${detail}`, timings, warmUrl, recreateAttempts, postDeleteStatusTimeline: awaitT.timeline, statusAtRecreate })
  }
  const recreateUrl = baseUrlFor(second, name)

  // 5. Post-recreate exec (poll up to 30s)
  let outcome: TrialResult["outcome"] = "OK"
  let detail: string | undefined
  let marker: string | undefined
  try {
    const t0 = Date.now()
    await execWithReady(recreateUrl, "echo ok", ctrl.signal)
    timings.recreateExec = Date.now() - t0
    const sameUrl = recreateUrl === warmUrl
    console.log(`${tag} OK recreate-exec=${timings.recreateExec}ms sameUrl=${sameUrl}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const bug = matchesBug(msg)
    if (bug) {
      outcome = "BUG"
      marker = bug
      detail = `post-recreate exec: ${msg}`
      console.error(`${tag} BUG post-recreate exec hit ${bug}`)
    } else {
      outcome = "FAIL"
      detail = `post-recreate exec: ${msg}`
      console.error(`${tag} FAIL post-recreate exec: ${msg}`)
    }
  } finally {
    await safeDelete(name)
  }

  return finish({ index, name, outcome, marker, detail, timings, warmUrl, recreateUrl, recreateAttempts, postDeleteStatusTimeline: awaitT.timeline, statusAtRecreate })
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

async function main() {
  if (!settings.workspace || !settings.authorization) {
    console.error("BL_WORKSPACE and BL_API_KEY must be set.")
    process.exit(2)
  }

  console.log()
  console.log("Recreate-same-name tombstone reproducer (TS port of customer's Go repro)")
  console.log(`  TOTAL=${TOTAL} PARALLEL=${PARALLEL}`)
  console.log(`  USE_CREATE_IF_NOT_EXIST=${USE_CREATE_IF_NOT_EXIST}`)
  console.log(`  READY_TIMEOUT_MS=${READY_TIMEOUT_MS} TRIAL_TIMEOUT_MS=${TRIAL_TIMEOUT_MS}`)
  console.log(`  TERMINATED_TIMEOUT_MS=${TERMINATED_TIMEOUT_MS} TERMINATED_POLL_MS=${TERMINATED_POLL_MS} POST_TERMINATED_WAIT_MS=${POST_TERMINATED_WAIT_MS}`)
  console.log(`  IMAGE=${IMAGE} REGION=${REGION} MEMORY_MB=${MEMORY_MB} TTL=${TTL}`)
  console.log(`  workspace=${settings.workspace} runUrl=${settings.runUrl}`)
  console.log()

  const queue = Array.from({ length: TOTAL }, (_, i) => i)
  const results: TrialResult[] = []
  async function worker() {
    while (queue.length > 0) {
      const i = queue.shift()!
      results.push(await trial(i))
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, TOTAL) }, () => worker()))
  results.sort((a, b) => a.index - b.index)

  console.log()
  console.log("=".repeat(72))
  console.log("RESULTS")
  console.log("=".repeat(72))

  const bugs = results.filter((r) => r.outcome === "BUG")
  const fails = results.filter((r) => r.outcome === "FAIL")
  const oks = results.filter((r) => r.outcome === "OK")

  const byMarker: Record<string, number> = {}
  for (const b of bugs) byMarker[b.marker || "UNKNOWN"] = (byMarker[b.marker || "UNKNOWN"] || 0) + 1

  console.log(`  ok    ${oks.length}/${results.length}`)
  console.log(`  BUG   ${bugs.length}/${results.length}  (delete-then-reuse hit)`)
  console.log(`  FAIL  ${fails.length}/${results.length}  (other / infra)`)
  if (bugs.length > 0) {
    console.log()
    console.log("  bug breakdown:")
    for (const [m, n] of Object.entries(byMarker)) console.log(`    ${m.padEnd(28)} ${n}`)
  }

  if (bugs.length > 0) {
    console.log()
    console.log(`=== ${bugs.length}/${results.length} hit the delete-then-reuse bug ===`)
    const byStatus: Record<string, number> = {}
    for (const r of bugs) {
      const s = r.statusAtRecreate ?? "UNKNOWN"
      byStatus[s] = (byStatus[s] || 0) + 1
    }
    console.log(`  bug grouped by status observed at recreate-time:`)
    for (const [s, n] of Object.entries(byStatus)) console.log(`    ${s.padEnd(12)} ${n}`)
    console.log()
    for (const r of bugs) {
      console.log(`  ${r.name}  marker=${r.marker}  statusAtRecreate=${r.statusAtRecreate}`)
      if (r.postDeleteStatusTimeline && r.postDeleteStatusTimeline.length > 0) {
        console.log(`    post-delete timeline = ${r.postDeleteStatusTimeline.map((t) => `${t.status}@${t.tMs}ms`).join(" -> ")}`)
      }
      if (r.timings.awaitTerminated !== undefined) {
        console.log(`    awaitTerminated      = ${r.timings.awaitTerminated}ms`)
      }
      if (r.warmUrl && r.recreateUrl) {
        console.log(`    warmUrl              = ${r.warmUrl}`)
        console.log(`    recreateUrl          = ${r.recreateUrl}`)
        console.log(`    sameUrl              = ${r.warmUrl === r.recreateUrl}`)
      }
      if (r.detail) console.log(`    detail               = ${r.detail.slice(0, 240)}`)
    }
  }

  if (fails.length > 0) {
    console.log()
    console.log("Non-bug failures:")
    for (const r of fails) console.log(`  ${r.name}: ${r.detail ?? "(no detail)"}`)
  }

  const awaitTermTimes = results.map((r) => r.timings.awaitTerminated).filter((v): v is number => typeof v === "number")
  if (awaitTermTimes.length > 0) {
    console.log()
    console.log(`Await TERMINATED (ms): p50=${percentile(awaitTermTimes, 50)} p90=${percentile(awaitTermTimes, 90)} max=${Math.max(...awaitTermTimes)}`)
  }
  const recreateTimes = results.map((r) => r.timings.recreate).filter((v): v is number => typeof v === "number")
  if (recreateTimes.length > 0) {
    console.log(`Recreate timings (ms): p50=${percentile(recreateTimes, 50)} p90=${percentile(recreateTimes, 90)} max=${Math.max(...recreateTimes)}`)
  }
  const recreateExecTimes = results.map((r) => r.timings.recreateExec).filter((v): v is number => typeof v === "number")
  if (recreateExecTimes.length > 0) {
    console.log(`Post-recreate exec ready (ms): p50=${percentile(recreateExecTimes, 50)} p90=${percentile(recreateExecTimes, 90)} max=${Math.max(...recreateExecTimes)}`)
  }

  console.log()
  process.exit(bugs.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
