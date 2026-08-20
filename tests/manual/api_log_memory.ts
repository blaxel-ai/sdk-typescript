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
//   LOG_DIR           process log directory in the guest (default /var/log/sandbox-api)
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
const LOG_DIR = process.env.LOG_DIR || "/var/log/sandbox-api"
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

// The API fills a process' `logs` asynchronously, so under a heavy workload an
// exec that already exited can still report no output. Redirect to a file in the
// guest and read that back instead, so a sample never depends on the log tailer
// having caught up.
async function run(sbx: SandboxInstance, command: string, label: string): Promise<string> {
  const out = `/tmp/manual-probe-${uuidv4().replace(/-/g, "").substring(0, 8)}`
  const result = await sbx.process.exec({
    // `command` must not contain a single quote: it is wrapped in one here.
    command: `sh -c '{ ${command} ; } > ${out} 2>&1'`,
    waitForCompletion: true,
    timeout: EXEC_TIMEOUT_S,
  })
  let content = ""
  try {
    content = (await sbx.fs.read(out)).trim()
  } finally {
    await sbx.process.exec({ command: `rm -f ${out}`, waitForCompletion: false }).catch(() => {})
  }
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode}):\n${content}`)
  }
  return content
}

// sandbox-api is the init of the PID namespace the processes it starts live in,
// so it is normally PID 1 in there; fall back to pgrep when it is not (local
// runs outside a sandbox).
async function apiPid(sbx: SandboxInstance): Promise<number> {
  const out = await run(
    sbx,
    "if grep -q sandbox-api /proc/1/cmdline; then echo 1; else pgrep -o -f sandbox-api; fi",
    "find the sandbox-api pid",
  )
  const pid = parseInt(out, 10)
  if (!Number.isFinite(pid)) {
    throw new Error(`could not find the sandbox-api pid, the guest said: ${JSON.stringify(out)}`)
  }
  return pid
}

type Probe = {
  bootId: string     // changes when the VM reboots
  apiStarted: string // /proc/<pid>/stat starttime, changes when sandbox-api is restarted
  rssMb: number
  logMb: number
}

// One round trip for everything, so a sample is consistent and cheap.
async function probe(sbx: SandboxInstance, pid: number): Promise<Probe> {
  const out = await run(
    sbx,
    "cat /proc/sys/kernel/random/boot_id; " +
      `cut -d" " -f22 /proc/${pid}/stat; ` +
      `grep VmRSS /proc/${pid}/status; ` +
      `{ du -sk ${LOG_DIR} 2>/dev/null || echo 0; }`,
    "probe the guest",
  )
  const lines = out.split("\n").map((l) => l.trim())
  const rss = /VmRSS:\s+(\d+)/.exec(out)
  const du = /(\d+)/.exec(lines[lines.length - 1] ?? "")
  if (!rss) {
    throw new Error(`could not read sandbox-api RSS, the guest said: ${JSON.stringify(out)}`)
  }
  return {
    bootId: lines[0] ?? "",
    apiStarted: lines[1] ?? "",
    rssMb: parseInt(rss[1], 10) / 1024,
    logMb: du ? parseInt(du[1], 10) / 1024 : 0,
  }
}

function describeRestart(first: Probe, now: Probe): string | undefined {
  if (now.bootId !== first.bootId) return "the VM rebooted (boot_id changed)"
  if (now.apiStarted !== first.apiStarted) return "sandbox-api was restarted (new process start time)"
  return undefined
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
    const pid = await apiPid(sbx)
    const first = await probe(sbx, pid)
    log(
      `Sandbox up. sandbox-api pid=${pid}, RSS=${first.rssMb.toFixed(1)}MB, ` +
      `boot_id=${first.bootId}, started=${first.apiStarted}`,
    )

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
    let maxRss = first.rssMb
    let maxLogMb = first.logMb
    const restarts: string[] = []
    const sample = async (label: string) => {
      const now = await probe(sbx, pid)
      maxRss = Math.max(maxRss, now.rssMb)
      maxLogMb = Math.max(maxLogMb, now.logMb)
      const restart = describeRestart(first, now)
      if (restart && !restarts.includes(restart)) {
        restarts.push(restart)
        console.error(`[log-memory] ${label}: ${restart}`)
      }
      return now
    }

    for (let i = 0; i < LIST_CALLS; i++) {
      const started = Date.now()
      const listed = await sbx.process.list()
      const bytes = JSON.stringify(listed).length
      maxListBytes = Math.max(maxListBytes, bytes)
      const now = await sample(`list #${i + 1}`)
      log(
        `  list #${i + 1}: ${(bytes / 1024).toFixed(0)}KB in ${Date.now() - started}ms, ` +
        `${Array.isArray(listed) ? listed.length : 0} processes, ` +
        `sandbox-api RSS=${now.rssMb.toFixed(1)}MB, logs=${now.logMb.toFixed(1)}MB` +
        (describeRestart(first, now) ? ` <- ${describeRestart(first, now)}` : ""),
      )
      await sleep(500)
    }

    // 3. Let them finish writing, then look at the totals. A process the API no
    // longer knows about is itself the failure: it lost its state, i.e. it was
    // restarted under us.
    log(`Waiting for the processes to finish`)
    const lost: string[] = []
    const stuck: string[] = []
    for (const name of names) {
      let settled = false
      for (let i = 0; i < 120 && !settled; i++) {
        try {
          const p = await sbx.process.get(name)
          settled = p.status !== "running"
        } catch (err) {
          if (`${err}`.includes("process not found")) {
            lost.push(name)
            settled = true
            break
          }
          throw err
        }
        if (settled) break
        if (i % 10 === 0) await sample(`waiting for ${name}`)
        await sleep(1000)
      }
      if (!settled) stuck.push(name)
    }
    check(
      stuck.length === 0,
      `${stuck.join(", ")} was still running after 120s — the numbers below do not cover all the output`,
    )
    check(
      lost.length === 0,
      `the API no longer knows about ${lost.join(", ")} — it lost its process table, so it was restarted`,
    )

    const last = await sample("after the writes")
    const totalWrittenMb = PROCESSES * OUTPUT_MB
    log(
      `Wrote ~${totalWrittenMb}MB total. sandbox-api RSS peak=${maxRss.toFixed(1)}MB ` +
      `(was ${first.rssMb.toFixed(1)}MB, now ${last.rssMb.toFixed(1)}MB), ` +
      `log dir peak=${maxLogMb.toFixed(1)}MB, ` +
      `largest list response=${(maxListBytes / 1024).toFixed(0)}KB`,
    )

    check(
      maxRss <= MAX_API_RSS_MB,
      `sandbox-api RSS peaked at ${maxRss.toFixed(1)}MB after ~${totalWrittenMb}MB of output ` +
      `(limit ${MAX_API_RSS_MB}MB) — the API is holding process output in memory`,
    )
    check(
      maxLogMb <= MAX_LOG_DIR_MB,
      `process log files use ${maxLogMb.toFixed(1)}MB of the guest tmpfs (limit ${MAX_LOG_DIR_MB}MB) — ` +
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
    if (lost.length === 0) {
      const logs = await sbx.process.logs(names[0])
      check(
        logs.length > 0,
        `GET /process/${names[0]}/logs returned ${logs.length} bytes — the output should still be readable from disk`,
      )
    }

    // 5. The OOM killer's victim must be the workload, not the API.
    const apiScore = await run(sbx, `cat /proc/${pid}/oom_score_adj`, "read sandbox-api oom_score_adj")
    check(parseInt(apiScore, 10) < 0, `sandbox-api oom_score_adj=${apiScore}, want a negative value`)

    await sbx.process.exec({ name: "victim", command: "sleep 60", waitForCompletion: false })
    const victim = await sbx.process.get("victim")
    const victimScore = await run(
      sbx,
      `cat /proc/${victim.pid}/oom_score_adj`,
      "read workload oom_score_adj",
    )
    check(
      parseInt(victimScore, 10) > 0,
      `a process started through the API has oom_score_adj=${victimScore}, want a positive value`,
    )

    // 6. Nothing restarted along the way.
    check(restarts.length === 0, `the sandbox did not stay up: ${restarts.join("; ")}`)

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
