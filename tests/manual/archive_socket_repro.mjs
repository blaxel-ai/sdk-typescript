/**
 * Reproducer for the two sandbox archive issues reported on sandbox-api 0.2.56:
 *
 *   1. A Unix socket on the filesystem makes the export die with
 *      `archive/tar: sockets not supported`.
 *   2. A failed export bricks the sandbox: the processes stopped for the export
 *      are never restarted, the control plane shows ARCHIVING forever, and both
 *      archive and unarchive answer 409.
 *
 * Flow, against the live API:
 *
 *   1. create sandbox NAME
 *   2. start a long-running process `worker` through the process API, and have
 *      it own a Unix socket at SOCKET_PATH (python3 or node, whichever the
 *      image has)
 *   3. archive the sandbox and wait for it to settle
 *   4. read the control plane status, and whether `worker` still runs
 *   5. call archive and unarchive once more, to see whether they answer 409
 *   6. when the sandbox is ARCHIVED, unarchive it and check `worker` is back
 *
 * Expected BEFORE the patch (sandbox-api <= 0.2.56, controlplane without
 * blaxel-ai/controlplane#5442):
 *   - archive never settles: the sandbox stays ARCHIVING past ARCHIVE_WAIT_MS
 *   - `worker` is gone
 *   - archive and unarchive both answer 409
 *   → BROKEN
 *
 * Expected AFTER the patch (blaxel-ai/sandbox#321 + blaxel-ai/controlplane#5442):
 *   - the socket is skipped, so the archive lands: the sandbox is ARCHIVED,
 *     unarchive brings it back DEPLOYED with `worker` running again
 *   → FIXED
 *   With only the controlplane patch deployed, the export still fails but the
 *   sandbox is handed back DEPLOYED quickly, and archive/unarchive no longer
 *   answer 409. With only the sandbox patch, the same happens and `worker` is
 *   running again. The script prints which of the checks hold either way.
 *
 * Env:
 *   BL_WORKSPACE, BL_API_KEY   auth (BL_ENV=dev to target dev)
 *   IMAGE                      default blaxel/base-image:latest
 *   BL_REGION                  default us-was-1 (eu-dub-1 with BL_ENV=dev)
 *   MEMORY_MB                  default 2048
 *   SOCKET_PATH                default /root/repro.sock (must be on the exported filesystem)
 *   ARCHIVE_WAIT_MS            how long to wait for the archive to settle, default 300000
 *   SKIP_SOCKET=1              do not create the socket (control run: archive must succeed)
 *   KEEP=1                     leave the sandbox behind for inspection
 *
 * Run:
 *   cd @blaxel/core && npm run build && cd ../..
 *   node tests/manual/archive_socket_repro.mjs
 */
import { SandboxInstance, settings } from "@blaxel/core"

const IMAGE = process.env.IMAGE || "blaxel/base-image:latest"
const REGION = process.env.BL_REGION || (process.env.BL_ENV === "dev" ? "eu-dub-1" : "us-was-1")
const MEMORY_MB = parseInt(process.env.MEMORY_MB || "2048", 10)
const ARCHIVE_WAIT_MS = parseInt(process.env.ARCHIVE_WAIT_MS || "300000", 10)
const SKIP_SOCKET = process.env.SKIP_SOCKET === "1"
const KEEP = process.env.KEEP === "1"
// Not under /tmp: a tmpfs is not part of the exported filesystem.
const SOCKET_PATH = process.env.SOCKET_PATH || "/root/repro.sock"
const WORKER = "worker"
const LABELS = { env: "manual-test", "created-by": "archive-socket-repro" }

const name = `archive-repro-${Date.now().toString(36)}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args)

const errorText = (err) => {
  if (err instanceof Error) return err.message
  if (err && typeof err === "object") return JSON.stringify(err)
  return String(err)
}
const is409 = (err) => {
  const e = err ?? {}
  return e.code === 409 || e.status === 409 || errorText(err).includes("409") || errorText(err).includes("already being archived")
}

/** The edge answers 502/504 for a moment after creation; retry idempotent calls. */
async function execRetry(sandbox, request, attempts = 10) {
  for (let i = 1; ; i++) {
    try {
      return await sandbox.process.exec(request)
    } catch (err) {
      if (i >= attempts || !/50[234]|unreachable/.test(errorText(err))) throw err
      log(`  exec not reachable yet (${errorText(err).slice(0, 60)}), retry ${i}/${attempts}`)
      await sleep(3000)
    }
  }
}

/** Command for a process that holds a Unix socket open, with what the image has. */
async function socketHolderCommand(sandbox) {
  const probe = await execRetry(sandbox, {
    command: "command -v python3 || command -v node || true",
    waitForCompletion: true,
  })
  const found = (probe.logs ?? "").trim()
  if (found.endsWith("python3")) {
    return `python3 -c "import socket,time; s=socket.socket(socket.AF_UNIX); s.bind('${SOCKET_PATH}'); s.listen(1); time.sleep(10**9)"`
  }
  if (found.endsWith("node")) {
    return `node -e "require('net').createServer().listen('${SOCKET_PATH}'); setInterval(() => {}, 1e9)"`
  }
  throw new Error(`neither python3 nor node in ${IMAGE}; pick an IMAGE that has one`)
}

async function workerStatus(sandbox) {
  try {
    const p = await sandbox.process.get(WORKER)
    return p.status ?? "unknown"
  } catch (err) {
    return `absent (${errorText(err).slice(0, 60)})`
  }
}

async function controlPlaneStatus() {
  const s = await SandboxInstance.get(name)
  return s.status ?? "UNKNOWN"
}

async function tryOnce(label, fn) {
  try {
    await fn()
    log(`  ${label}: accepted`)
    return "accepted"
  } catch (err) {
    const kind = is409(err) ? "409" : "error"
    log(`  ${label}: ${kind} - ${errorText(err).slice(0, 160)}`)
    return kind
  }
}

async function main() {
  if (!settings.workspace || !settings.authorization) {
    console.error("BL_WORKSPACE and BL_API_KEY must be set.")
    process.exit(2)
  }
  log(`workspace=${settings.workspace} region=${REGION} image=${IMAGE} sandbox=${name} socket=${!SKIP_SOCKET}`)

  const sandbox = await SandboxInstance.create({
    name,
    image: IMAGE,
    memory: MEMORY_MB,
    region: REGION,
    labels: LABELS,
    ttl: "2h",
  })
  await sandbox.wait()
  log("created")

  let exitCode = 1
  try {
    const command = SKIP_SOCKET ? "sleep 1000000" : await socketHolderCommand(sandbox)
    await execRetry(sandbox, { name: WORKER, command, waitForCompletion: false })
    await sleep(2000)
    log(`worker before archive: ${await workerStatus(sandbox)}`)
    if (!SKIP_SOCKET) {
      const ls = await sandbox.process.exec({ command: `ls -l ${SOCKET_PATH}`, waitForCompletion: true })
      log(`socket: ${(ls.logs ?? "").trim() || "(missing!)"}`)
    }

    // 3. archive
    log(`archiving, waiting up to ${ARCHIVE_WAIT_MS / 1000}s ...`)
    let archiveOutcome
    try {
      await SandboxInstance.archive(name, { wait: true, maxWait: ARCHIVE_WAIT_MS, interval: 3000 })
      archiveOutcome = "ARCHIVED"
    } catch (err) {
      archiveOutcome = errorText(err)
    }
    log(`archive: ${archiveOutcome}`)

    // 4. what is left
    const status = await controlPlaneStatus()
    log(`control plane status: ${status}`)
    let worker = "n/a (sandbox archived)"
    if (status !== "ARCHIVED") {
      worker = await workerStatus(sandbox)
      log(`worker after failed/pending archive: ${worker}`)
    }

    // 5. are archive/unarchive still usable?
    const retry = {}
    if (status !== "ARCHIVED") {
      log("retrying archive and unarchive without waiting:")
      retry.archive = await tryOnce("archive", () => SandboxInstance.archive(name, { wait: false }))
      retry.unarchive = await tryOnce("unarchive", () => SandboxInstance.unarchive(name, { wait: false }))
    }

    // 6. round trip when the archive landed
    let restoredWorker
    if (status === "ARCHIVED") {
      log("unarchiving ...")
      await SandboxInstance.unarchive(name, { wait: true, maxWait: ARCHIVE_WAIT_MS, interval: 3000 })
      await sleep(3000)
      restoredWorker = await workerStatus(sandbox)
      log(`worker after unarchive: ${restoredWorker}`)
    }

    console.log()
    console.log("=".repeat(72))
    const stuck = status === "ARCHIVING"
    const bricked409 = retry.archive === "409" && retry.unarchive === "409"
    const workerRunning = (worker ?? "").startsWith("running")
    if (status === "ARCHIVED") {
      console.log(`FIXED: archive landed with a socket on disk, unarchive gave the sandbox back with worker=${restoredWorker}`)
      exitCode = (restoredWorker ?? "").startsWith("running") ? 0 : 1
    } else if (stuck || bricked409) {
      console.log(`BROKEN: status=${status}, worker=${worker}, archive retry=${retry.archive}, unarchive retry=${retry.unarchive}`)
      exitCode = 1
    } else {
      console.log(`PARTIAL: export failed but the sandbox was handed back (status=${status}); worker ${workerRunning ? "is running again" : `is ${worker}`}; archive retry=${retry.archive}, unarchive retry=${retry.unarchive}`)
      exitCode = workerRunning ? 0 : 1
    }
    console.log("=".repeat(72))
  } finally {
    if (KEEP) {
      log(`KEEP=1: leaving ${name} behind`)
    } else {
      await SandboxInstance.delete(name).catch((err) => log(`delete failed: ${errorText(err)}`))
      log("deleted")
    }
  }
  process.exit(exitCode)
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
