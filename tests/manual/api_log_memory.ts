// Manual test: chatty processes must not make sandbox-api the OOM victim.
//
// Reproduces the incident behind sandbox#304: a customer workload writes a lot
// of output, sandbox-api keeps all of it (stdout + stderr + a combined copy) in
// its heap forever, becomes the fattest process in the guest, and the kernel
// OOM-killer picks *the API* instead of the workload. The guest then sees
// "Workload killed by signal 9" and restarts the sandbox, losing the tmpfs.
//
// The same output is also inlined in every `GET /process` response, so listing
// processes allocates another full copy of everything per call.
//
// What it checks, against a live sandbox:
//   1. sandbox-api's RSS stays bounded while processes write hundreds of MB
//      (before the fix it grows roughly with the total output).
//   2. `process.list()` responses stay bounded (tail only, not whole logs).
//   3. `process.logs(id)` still returns the output, read from disk.
//   4. The log files on disk stay under the configured cap, so a runaway
//      process cannot fill the (RAM-backed) tmpfs either.
//   5. oom_score_adj is set so the workload, not the API, is the victim.
//   6. The sandbox never restarts: same boot_id, processes still known.
//
// Run (after `cd @blaxel/core && npm run build`):
//
//   npx tsx tests/manual/api_log_memory.ts
//
// Env vars:
//   NAME              sandbox name (default: logmem-<random>)
//   IMAGE             sandbox image (default blaxel/base-image:latest)
//   REGION            region to create the sandbox in (optional)
//   MEMORY_MB         sandbox memory in MB (default 1024)
//   PROCESSES         number of chatty processes (default 4)
//   OUTPUT_MB         output per process, in MB (default 128)
//   LIST_CALLS        how many times to call process.list() (default 20)
//   MAX_API_RSS_MB    fail if sandbox-api RSS exceeds this (default 256)
//   MAX_LOG_DIR_MB    fail if the log dir exceeds this (default 512)
//   CLEANUP           delete the sandbox at the end (default "true")

// Disable H2 to work around PM-2160 (h2 stream unref -> event loop exits mid-await).
// Must be set BEFORE importing @blaxel/core.
process.env.BL_DISABLE_H2 = process.env.BL_DISABLE_H2 ?? "1"

import { SandboxInstance } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason)
})

const NAME = process.env.NAME || `logmem-${uuidv4().replace(/-/g, "").substring(0, 8)}`
const IMAGE = process.env.IMAGE || "blaxel/base-image:latest"
const REGION = process.env.REGION
const MEMORY_MB = parseInt(process.env.MEMORY_MB || "1024", 10)
const PROCESSES = parseInt(process.env.PROCESSES || "4", 10)
const OUTPUT_MB = parseInt(process.env.OUTPUT_MB || "128", 10)
const LIST_CALLS = parseInt(process.env.LIST_CALLS || "20", 10)
const MAX_API_RSS_MB = parseInt(process.env.MAX_API_RSS_MB || "256", 10)
const MAX_LOG_DIR_MB = parseInt(process.env.MAX_LOG_DIR_MB || "512", 10)
const CLEANUP = (process.env.CLEANUP ?? "true") === "true"
const LABELS = { env: "manual-test", "created-by": "api-log-memory" }

const EXEC_TIMEOUT_S = 120
// Each process writes OUTPUT_MB of text to stdout and a tenth of it to stderr.
const CHATTY_COMMAND =
  `sh -c 'dd if=/dev/zero bs=1M count=${OUTPUT_MB} 2>/dev/null | tr "\\0" "a"; ` +
  `dd if=/dev/zero bs=1M count=${Math.max(1, Math.floor(OUTPUT_MB / 10))} 2>/dev/null | tr "\\0" "b" >&2'`

const failures: string[] = []

function log(msg: string) {
  console.log(`[log-memory] ${msg}`)
}

function check(ok: boolean, msg: string) {
  if (ok) {
    log(`OK: ${msg}`)
  } else {
    failures.push(msg)
    console.error(`[log-memory] FAIL: ${msg}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function run(sbx: SandboxInstance, command: string, label: string): Promise<string> {
  const result = await sbx.process.exec({ command, waitForCompletion: true, timeout: EXEC_TIMEOUT_S })
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode}):\n${result.logs ?? ""}`)
  }
  return result.logs?.trim() ?? ""
}

async function apiRssMb(sbx: SandboxInstance): Promise<number> {
  const out = await run(
    sbx,
    "sh -c 'grep VmRSS /proc/$(pgrep -o -f sandbox-api)/status | awk \"{print \\$2}\"'",
    "read sandbox-api RSS",
  )
  return parseInt(out, 10) / 1024
}

async function logDirMb(sbx: SandboxInstance): Promise<number> {
  const out = await run(sbx, "sh -c 'du -sk /var/log/sandbox-api | cut -f1'", "measure log dir")
  return parseInt(out, 10) / 1024
}

async function bootId(sbx: SandboxInstance): Promise<string> {
  return await run(sbx, "cat /proc/sys/kernel/random/boot_id", "read boot_id")
}

async function main() {
  log(`Creating sandbox ${NAME} (image=${IMAGE}, memory=${MEMORY_MB}MB${REGION ? `, region=${REGION}` : ""})`)
  const sbx = await SandboxInstance.create({
    name: NAME,
    image: IMAGE,
    memory: MEMORY_MB,
    labels: LABELS,
    ...(REGION ? { region: REGION } : {}),
  })
  await sbx.wait()

  try {
    const bootBefore = await bootId(sbx)
    const rssBefore = await apiRssMb(sbx)
    log(`Sandbox up. boot_id=${bootBefore}, sandbox-api RSS=${rssBefore.toFixed(1)}MB`)

    // 1. Start the chatty processes.
    log(`Starting ${PROCESSES} processes writing ~${OUTPUT_MB}MB of stdout each`)
    const names: string[] = []
    for (let i = 0; i < PROCESSES; i++) {
      const name = `chatty-${i}`
      await sbx.process.exec({ name, command: CHATTY_COMMAND, waitForCompletion: false })
      names.push(name)
    }

    // 2. Hammer the list endpoint while they run: that is the path that used to
    // inline every process' whole output in one response.
    let maxListBytes = 0
    let maxRss = rssBefore
    for (let i = 0; i < LIST_CALLS; i++) {
      const started = Date.now()
      const listed = await sbx.process.list()
      const bytes = JSON.stringify(listed).length
      maxListBytes = Math.max(maxListBytes, bytes)
      const rss = await apiRssMb(sbx)
      maxRss = Math.max(maxRss, rss)
      log(
        `  list #${i + 1}: ${(bytes / 1024).toFixed(0)}KB in ${Date.now() - started}ms, ` +
        `${Array.isArray(listed) ? listed.length : 0} processes, sandbox-api RSS=${rss.toFixed(1)}MB`,
      )
      await sleep(500)
    }

    // 3. Let them finish writing, then look at the totals.
    log(`Waiting for the processes to finish`)
    for (const name of names) {
      for (let i = 0; i < 120; i++) {
        const p = await sbx.process.get(name)
        if (p.status !== "running") break
        await sleep(1000)
      }
    }
    const rssAfter = await apiRssMb(sbx)
    maxRss = Math.max(maxRss, rssAfter)
    const dirMb = await logDirMb(sbx)
    const totalWrittenMb = PROCESSES * OUTPUT_MB
    log(
      `Wrote ~${totalWrittenMb}MB total. sandbox-api RSS peak=${maxRss.toFixed(1)}MB ` +
      `(was ${rssBefore.toFixed(1)}MB), log dir=${dirMb.toFixed(1)}MB, ` +
      `largest list response=${(maxListBytes / 1024).toFixed(0)}KB`,
    )

    check(
      maxRss <= MAX_API_RSS_MB,
      `sandbox-api RSS peaked at ${maxRss.toFixed(1)}MB after ~${totalWrittenMb}MB of output ` +
      `(limit ${MAX_API_RSS_MB}MB) — the API is holding process output in memory`,
    )
    check(
      dirMb <= MAX_LOG_DIR_MB,
      `process log files use ${dirMb.toFixed(1)}MB of the guest tmpfs (limit ${MAX_LOG_DIR_MB}MB) — ` +
      `the per-file cap is not being enforced`,
    )
    // A bounded list response: a tail per stream per process, not whole logs.
    const listLimitBytes = PROCESSES * 3 * 256 * 1024
    check(
      maxListBytes <= listLimitBytes,
      `the largest GET /process response was ${(maxListBytes / 1024).toFixed(0)}KB ` +
      `(limit ${(listLimitBytes / 1024).toFixed(0)}KB) — the list is inlining full logs`,
    )

    // 4. The full output is still retrievable, from disk.
    const logs = await sbx.process.logs(names[0])
    check(
      logs.length > 0,
      `GET /process/${names[0]}/logs returned ${logs.length} bytes — the output should still be readable from disk`,
    )

    // 5. The OOM killer's victim must be the workload, not the API.
    const apiScore = await run(
      sbx,
      "sh -c 'cat /proc/$(pgrep -o -f sandbox-api)/oom_score_adj'",
      "read sandbox-api oom_score_adj",
    )
    check(parseInt(apiScore, 10) < 0, `sandbox-api oom_score_adj=${apiScore}, want a negative value`)

    await sbx.process.exec({ name: "victim", command: "sleep 60", waitForCompletion: false })
    const victimScore = await run(
      sbx,
      "sh -c 'cat /proc/$(pgrep -o -f \"sleep 60\")/oom_score_adj'",
      "read workload oom_score_adj",
    )
    check(
      parseInt(victimScore, 10) > 0,
      `a process started through the API has oom_score_adj=${victimScore}, want a positive value`,
    )

    // 6. Nothing restarted along the way.
    const bootAfter = await bootId(sbx)
    check(bootAfter === bootBefore, `boot_id changed (${bootBefore} -> ${bootAfter}) — the sandbox restarted`)
    const stillListed = await sbx.process.list()
    check(
      Array.isArray(stillListed) && stillListed.length > 0,
      `the API still knows about its processes (sandbox-api was not restarted)`,
    )

    if (failures.length > 0) {
      throw new Error(`log-memory test FAILED:\n  - ${failures.join("\n  - ")}`)
    }
    log(`SUCCESS: ~${totalWrittenMb}MB of output, sandbox-api stayed at ${maxRss.toFixed(1)}MB and never restarted`)
  } finally {
    if (CLEANUP) {
      log(`Deleting sandbox ${NAME}`)
      try { await SandboxInstance.delete(NAME) } catch (err) {
        console.error(`[log-memory] cleanup failed:`, err)
      }
    } else {
      log(`CLEANUP=false — sandbox ${NAME} left running`)
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[log-memory] FAILED:", err)
    process.exit(1)
  },
)
