// Reproducer: delete a volume while a sandbox that mounts it is being created.
//
// Shape of the bug (ENG-4642): the control plane only refuses a volume delete
// once the volume is logically attached to a sandbox, and the actual PVC / UKC
// teardown is asynchronous. So a delete accepted just before (or during) a
// create tears the PVC down while the virtual-kubelet is still preparing the
// instance. The pod then never becomes ready: the create hangs past the edge's
// 60s timeout and the sandbox keeps answering WORKLOAD_UNAVAILABLE for another
// 1-3 min instead of failing.
//
// Two modes:
//   MODE=pre   (default) deterministic: the delete is accepted first — nothing
//              is attached yet — and the sandbox create starts immediately
//              after, so it runs against a PVC that is being deleted.
//   MODE=race  the customer's exact timing: the delete is hammered concurrently
//              with the create until it either lands in the window before the
//              attach commits (race won) or is refused because the volume is
//              already attached (race lost, retried with a fresh pair).
//
// Expected before the fix: create hangs ~60s+ and the sandbox never serves.
// Expected after the fix: the sandbox goes to FAILED quickly.
//
// Credentials are picked up automatically via @blaxel/core autoload (local
// `bl login` config / env), so BL_WORKSPACE / BL_API_KEY are not required here.
//
// Run (after `npm run build` in @blaxel/core):
//
//   npx tsx tests/manual/volume_delete_during_create.ts
//
// Env vars:
//   BL_ENV                     "dev" to target api.blaxel.dev (default prod)
//   MODE                       "pre" (default) or "race"
//   ITERATIONS                 how many volume/sandbox pairs to try (default 10)
//   CONCURRENCY                pairs in flight at once (default 1)
//   STUCK_MS                   create duration considered stuck (default 60000)
//   STOP_ON_STUCK              "0" to keep going after the first stuck create (default stop)
//   REGION / BL_REGION         region for volume + sandbox (default us-was-1)
//   SIZE_MB                    volume size in MB (default 300, like the report)
//   MOUNT_PATH                 volume mount path (default /home)
//   DELETE_WINDOW_MS           how long to hammer the delete in race mode (default 15000)
//   WATCH_TIMEOUT_MS           how long to watch the sandbox afterwards (default 240000)
//   IMAGE                      sandbox image (default blaxel/base-image:latest)
//   KEEP                       "1" to keep the resources of a stuck iteration for inspection

// Disable H2 to work around PM-2160 (h2 stream unref -> event loop exits mid-await).
// Must be set BEFORE importing @blaxel/core.
process.env.BL_DISABLE_H2 = process.env.BL_DISABLE_H2 ?? "1"

import { SandboxInstance, VolumeInstance } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"

const MODE_ENV = process.env.MODE || "pre"
const MODE = MODE_ENV as "pre" | "race"
const ITERATIONS = parseInt(process.env.ITERATIONS || "10", 10)
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || "1", 10))
const STUCK_MS = parseInt(process.env.STUCK_MS || "60000", 10)
const STOP_ON_STUCK = process.env.STOP_ON_STUCK !== "0"
const REGION = process.env.REGION || process.env.BL_REGION || "us-was-1"
const SIZE_MB = parseInt(process.env.SIZE_MB || "300", 10)
const MOUNT_PATH = process.env.MOUNT_PATH || "/home"
const DELETE_WINDOW_MS = parseInt(process.env.DELETE_WINDOW_MS || "15000", 10)
const WATCH_TIMEOUT_MS = parseInt(process.env.WATCH_TIMEOUT_MS || "240000", 10)
const IMAGE = process.env.IMAGE || "blaxel/base-image:latest"
const KEEP = process.env.KEEP === "1"
const LABELS = { env: "manual-test", "created-by": "volume-delete-during-create" }

const t0 = Date.now()

function elapsed(): string {
  return `${((Date.now() - t0) / 1000).toFixed(1)}s`
}

function log(msg: string) {
  console.log(`[${elapsed().padStart(7)}] ${msg}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return typeof e === "string" ? e : JSON.stringify(e)
}

// The control plane answers 400 "Volume is attached to sandbox:<name>" once the
// create has claimed the volume, which means the race is lost for this pair.
function isAttachedRejection(message: string): boolean {
  return message.includes("Volume is attached to")
}

type DeleteRace = {
  accepted: boolean
  attempts: number
  lastError?: string
}

// Hammer the delete with no backoff: we want the request that lands in the gap
// between the create being accepted and the volume being marked as attached.
async function raceVolumeDelete(volumeName: string, stop: () => boolean): Promise<DeleteRace> {
  const deadline = Date.now() + DELETE_WINDOW_MS
  let attempts = 0
  let lastError: string | undefined

  while (Date.now() < deadline && !stop()) {
    attempts++
    try {
      await VolumeInstance.delete(volumeName)
      return { accepted: true, attempts }
    } catch (e) {
      lastError = errorMessage(e)
      if (isAttachedRejection(lastError)) return { accepted: false, attempts, lastError }
    }
  }

  return { accepted: false, attempts, lastError }
}

// Poll the sandbox record, logging status transitions, and probe fs.ls to tell a
// DEPLOYED-but-unavailable box apart from one that really serves.
async function watchSandbox(name: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastStatus = ""

  while (Date.now() < deadline) {
    let sbx: SandboxInstance | null = null
    let status = "UNKNOWN"
    try {
      sbx = await SandboxInstance.get(name)
      status = sbx.status ?? "UNKNOWN"
    } catch (e) {
      status = `GET_FAILED (${errorMessage(e)})`
    }

    if (status !== lastStatus) {
      log(`sandbox status: ${status}`)
      lastStatus = status
    }

    if (status === "FAILED" || status === "TERMINATED") return status

    if (status === "DEPLOYED" && sbx) {
      try {
        await sbx.fs.ls("/")
        return "SERVING"
      } catch (e) {
        const message = errorMessage(e)
        // A 401 here is a data-plane credential problem, not the bug: the box is
        // answering, so treat it as serving rather than as an endless wait.
        if (message.includes("401")) return "SERVING (fs.ls unauthorized, data plane reachable)"
        log(`DEPLOYED but not serving yet: ${message}`)
      }
    }

    await sleep(2000)
  }

  return `WATCH_TIMEOUT (last: ${lastStatus})`
}

type Attempt = {
  iteration: number
  sandboxName: string
  volumeName: string
  deleteAccepted: boolean
  deleteAttempts: number
  deleteError?: string
  createMs: number
  createError?: string
  outcome?: string
}

async function createSandboxTimed(
  sandboxName: string,
  volumeName: string,
): Promise<{ createMs: number; createError?: string }> {
  const start = Date.now()
  try {
    await SandboxInstance.create({
      name: sandboxName,
      image: IMAGE,
      region: REGION,
      labels: LABELS,
      volumes: [{ name: volumeName, mountPath: MOUNT_PATH, readOnly: false }],
    })
    return { createMs: Date.now() - start }
  } catch (e) {
    return { createMs: Date.now() - start, createError: errorMessage(e) }
  }
}

async function attempt(iteration: number): Promise<Attempt> {
  const suffix = uuidv4().replace(/-/g, "").substring(0, 8)
  const volumeName = `voldel-${suffix}-vol`
  const sandboxName = `voldel-${suffix}`

  log(`#${iteration}: creating volume ${volumeName} (${SIZE_MB} MB, ${REGION})`)
  await VolumeInstance.create({ name: volumeName, size: SIZE_MB, region: REGION, labels: LABELS })

  let deleteResult: DeleteRace
  let created: { createMs: number; createError?: string }

  if (MODE === "pre") {
    // Deterministic: the delete is accepted while nothing is attached, then the
    // create immediately races the asynchronous PVC / UKC teardown.
    try {
      await VolumeInstance.delete(volumeName)
      deleteResult = { accepted: true, attempts: 1 }
      log(`#${iteration}: volume delete accepted, creating sandbox ${sandboxName} right away`)
    } catch (e) {
      deleteResult = { accepted: false, attempts: 1, lastError: errorMessage(e) }
      log(`#${iteration}: volume delete refused: ${deleteResult.lastError}`)
    }
    created = await createSandboxTimed(sandboxName, volumeName)
  } else {
    log(`#${iteration}: creating sandbox ${sandboxName} while hammering the volume delete`)
    let createSettled = false
    const race = raceVolumeDelete(volumeName, () => createSettled)
    created = await createSandboxTimed(sandboxName, volumeName)
    createSettled = true
    deleteResult = await race
  }

  log(
    `#${iteration}: create ${created.createError ? "failed" : "returned"} after ${(created.createMs / 1000).toFixed(1)}s; ` +
    `volume delete ${deleteResult.accepted ? `accepted after ${deleteResult.attempts} attempt(s)` : `refused (${deleteResult.attempts} attempt(s): ${deleteResult.lastError ?? "no error"})`}`,
  )
  if (created.createError) log(`#${iteration}: create error: ${created.createError}`)

  const result: Attempt = {
    iteration,
    sandboxName,
    volumeName,
    deleteAccepted: deleteResult.accepted,
    deleteAttempts: deleteResult.attempts,
    deleteError: deleteResult.lastError,
    createMs: created.createMs,
    createError: created.createError,
  }

  if (deleteResult.accepted && !created.createError) {
    result.outcome = await watchSandbox(sandboxName, WATCH_TIMEOUT_MS)
    log(`#${iteration}: sandbox outcome: ${result.outcome}`)
  }

  return result
}

async function cleanup(a: Attempt) {
  await SandboxInstance.delete(a.sandboxName).catch((e) => log(`sandbox delete failed: ${errorMessage(e)}`))
  await VolumeInstance.delete(a.volumeName).catch(() => { })
}

// A stuck create is the bug: the create burned past the gateway budget, or the
// sandbox never reached a serving state within the watch window.
function isStuck(a: Attempt): boolean {
  if (a.createMs >= STUCK_MS) return true
  return a.outcome !== undefined && !a.outcome.startsWith("SERVING")
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
}

function report(attempts: Attempt[]) {
  const durations = attempts.map((a) => a.createMs).sort((x, y) => x - y)
  const stuck = attempts.filter(isStuck)
  const outcomes = new Map<string, number>()
  for (const a of attempts) {
    const key = a.createError ? `create failed: ${a.createError}` : (a.outcome ?? "not watched")
    outcomes.set(key, (outcomes.get(key) ?? 0) + 1)
  }

  console.log("\n=== volume delete during create ===")
  console.log(`mode               : ${MODE} (concurrency ${CONCURRENCY})`)
  console.log(`iterations run     : ${attempts.length}/${ITERATIONS}`)
  console.log(`delete accepted    : ${attempts.filter((a) => a.deleteAccepted).length}/${attempts.length}`)
  console.log(`stuck creates      : ${stuck.length}/${attempts.length} (>= ${(STUCK_MS / 1000).toFixed(0)}s or never served)`)
  console.log(
    `create duration    : min ${(durations[0] / 1000).toFixed(1)}s / p50 ${(percentile(durations, 0.5) / 1000).toFixed(1)}s / max ${(durations[durations.length - 1] / 1000).toFixed(1)}s`,
  )
  console.log(`outcomes           :`)
  for (const [outcome, count] of [...outcomes].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)} x ${outcome}`)
  }
  for (const a of stuck) {
    console.log(
      `stuck #${a.iteration}         : ${a.sandboxName} / ${a.volumeName} — create ${(a.createMs / 1000).toFixed(1)}s, ${a.createError ?? a.outcome ?? "n/a"}`,
    )
  }
  console.log(`total              : ${elapsed()}`)
}

async function runAndCleanup(iteration: number): Promise<Attempt> {
  const a = await attempt(iteration)
  if (KEEP && isStuck(a)) log(`#${iteration}: KEEP=1, leaving ${a.sandboxName} and ${a.volumeName} in place`)
  else await cleanup(a)
  return a
}

async function main() {
  if (MODE_ENV !== "pre" && MODE_ENV !== "race") throw new Error(`MODE must be "pre" or "race", got ${MODE_ENV}`)

  const attempts: Attempt[] = []

  for (let i = 1; i <= ITERATIONS; i += CONCURRENCY) {
    const batch: Promise<Attempt>[] = []
    for (let j = i; j < Math.min(i + CONCURRENCY, ITERATIONS + 1); j++) batch.push(runAndCleanup(j))
    attempts.push(...(await Promise.all(batch)))

    if (STOP_ON_STUCK && attempts.some(isStuck)) {
      log(`stuck create observed, stopping after ${attempts.length} iteration(s) (STOP_ON_STUCK=0 to keep going)`)
      break
    }
  }

  report(attempts)
}

main().catch((e) => {
  console.error(`[${elapsed()}] fatal: ${errorMessage(e)}`)
  process.exit(1)
})
