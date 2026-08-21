// Manual test: a chatty process must not make sandbox-api the OOM victim.
//
// Reproduces the incident behind sandbox#304: a customer workload writes a lot
// of output, sandbox-api keeps all of it (stdout + stderr + a combined copy) in
// its heap forever, becomes the fattest process in the guest, and the kernel
// OOM-killer picks *the API* instead of the workload. The guest then logs
// "Workload killed by signal 9" and restarts, losing the tmpfs.
//
// Shape of the run: one process writes output slowly, in steps, in a 1GB
// sandbox, while every second we sample sandbox-api's RSS, the guest's free
// memory and the size of the log directory — so the growth is visible as it
// happens instead of only in a pass/fail at the end. The run stops as soon as
// something dies, and then reports what survived:
//
//   * the boot_id (unchanged = the VM did not reboot)
//   * sandbox-api's start time (unchanged = the API was not restarted)
//   * a file written before the writes started (present = tmpfs survived)
//   * the process table (the writer still known = the API did not lose state)
//   * oom_score_adj of the API and of a process it started
//
// A probe that stops answering is itself reported (with the guest's OOM
// evidence when we can still read it) rather than aborting the run.
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
//   STEP_MB           output written per step, in MB (default 16)
//   MAX_MB            stop after this much output (default 4096)
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
const STEP_MB = parseInt(process.env.STEP_MB || "16", 10)
const MAX_MB = parseInt(process.env.MAX_MB || "4096", 10)
const MAX_API_RSS_MB = parseInt(process.env.MAX_API_RSS_MB || "256", 10)
const MAX_LOG_DIR_MB = parseInt(process.env.MAX_LOG_DIR_MB || "512", 10)
const CLEANUP = (process.env.CLEANUP ?? "true") === "true"
const LOG_DIR = process.env.LOG_DIR || "/var/log/sandbox-api"
const LABELS = { env: "manual-test", "created-by": "api-log-memory" }

const WRITER = "chatty"
const MARKER = "/root/logmem-marker"
const MARKER_CONTENT = `written before the writes started: ${NAME}`
const EXEC_TIMEOUT_S = 60

// One step per second, so the growth is gradual and every sample sees a bit
// more output. A tenth of each step goes to stderr, which the API keeps as a
// second copy.
const WRITER_COMMAND =
  `sh -c 'written=0; while [ $written -lt ${MAX_MB} ]; do ` +
  `dd if=/dev/zero bs=1M count=${STEP_MB} 2>/dev/null | tr "\\0" "a"; ` +
  `dd if=/dev/zero bs=1M count=1 2>/dev/null | tr "\\0" "b" >&2; ` +
  `written=$((written + ${STEP_MB} + 1)); sleep 1; done'`

const failures: string[] = []

function log(msg: string) {
  console.log(`[log-memory] ${msg}`)
}

// `whenOk` describes the good outcome, `whenNotOk` the bad one, so a line never
// reads like the opposite of what happened.
function check(ok: boolean, whenOk: string, whenNotOk: string) {
  if (ok) {
    log(`OK: ${whenOk}`)
  } else {
    failures.push(whenNotOk)
    console.error(`[log-memory] FAIL: ${whenNotOk}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The API fills a process' `logs` asynchronously, so under a heavy workload an
// exec that already exited can still report no output. Redirect to a file in
// the guest and read that back, so a sample never depends on the log tailer
// having caught up.
//
// `command` must not contain a single quote: it is wrapped in one here.
async function run(sbx: SandboxInstance, command: string): Promise<string> {
  const out = `/tmp/manual-probe-${uuidv4().replace(/-/g, "").substring(0, 8)}`
  await sbx.process.exec({
    command: `sh -c '{ ${command} ; } > ${out} 2>&1'`,
    waitForCompletion: true,
    timeout: EXEC_TIMEOUT_S,
  })
  try {
    return (await sbx.fs.read(out)).trim()
  } finally {
    void sbx.process.exec({ command: `rm -f ${out}`, waitForCompletion: false }).catch(() => {})
  }
}

// sandbox-api is the init of the PID namespace the processes it starts live in,
// so it is normally PID 1 in there; fall back to pgrep when it is not (local
// runs outside a sandbox).
async function apiPid(sbx: SandboxInstance): Promise<number> {
  const out = await run(sbx, "if grep -q sandbox-api /proc/1/cmdline; then echo 1; else pgrep -o -f sandbox-api; fi")
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
  availableMb: number
}

async function probe(sbx: SandboxInstance, pid: number): Promise<Probe> {
  const out = await run(
    sbx,
    "cat /proc/sys/kernel/random/boot_id; " +
      `cut -d" " -f22 /proc/${pid}/stat; ` +
      `grep VmRSS /proc/${pid}/status; ` +
      "grep MemAvailable /proc/meminfo; " +
      `{ du -sk ${LOG_DIR} 2>/dev/null || echo 0; }`,
  )
  const rss = /VmRSS:\s+(\d+)/.exec(out)
  const available = /MemAvailable:\s+(\d+)/.exec(out)
  if (!rss) {
    throw new Error(`no VmRSS for pid ${pid}, the guest said: ${JSON.stringify(out)}`)
  }
  const lines = out.split("\n").map((l) => l.trim())
  const du = /(\d+)/.exec(lines[lines.length - 1] ?? "")
  return {
    bootId: lines[0] ?? "",
    apiStarted: lines[1] ?? "",
    rssMb: parseInt(rss[1], 10) / 1024,
    logMb: du ? parseInt(du[1], 10) / 1024 : 0,
    availableMb: available ? parseInt(available[1], 10) / 1024 : NaN,
  }
}

// Best effort: whatever the guest can still tell us about why a probe failed.
async function diagnose(sbx: SandboxInstance): Promise<string> {
  try {
    const out = await run(
      sbx,
      "cat /proc/sys/kernel/random/boot_id; " +
        "grep MemAvailable /proc/meminfo; " +
        "{ dmesg 2>/dev/null | grep -iE \"out of memory|killed process|oom-kill\" | tail -5 || true; }",
    )
    return out.split("\n").map((l) => l.trim()).filter(Boolean).join(" | ") || "the guest answered nothing"
  } catch (err) {
    return `the guest did not answer: ${err}`
  }
}

// Why did the API forget a process? Either it went down and came back (in which
// case its start time or the VM's boot_id changed), or it is the same process
// that lost its state. The distinction is the whole point of the run, so ask the
// guest before concluding anything.
async function attribute(sbx: SandboxInstance, pid: number, first: Probe): Promise<string> {
  let now: Probe | undefined
  try {
    now = await probe(sbx, pid)
  } catch {
    // Fall through to the raw diagnosis below.
  }
  const evidence = await diagnose(sbx)
  if (!now) return `the guest no longer answers probes either — ${evidence}`
  if (now.bootId !== first.bootId) return `the VM rebooted (boot_id changed) — ${evidence}`
  if (now.apiStarted !== first.apiStarted) {
    return `sandbox-api was restarted (start time ${first.apiStarted} -> ${now.apiStarted}) — ${evidence}`
  }
  return `the same sandbox-api process (start time ${now.apiStarted}) lost it from its process table — ${evidence}`
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
      `Sandbox up. sandbox-api pid=${pid}, RSS=${first.rssMb.toFixed(1)}MB, available=${first.availableMb.toFixed(0)}MB, ` +
      `boot_id=${first.bootId}, started=${first.apiStarted}`,
    )

    // A file that must still be there afterwards: it is on the VM's tmpfs root,
    // so it only disappears if the VM was reset rather than recovered.
    await sbx.fs.write(MARKER, MARKER_CONTENT)

    log(`Starting one process writing ${STEP_MB}MB of stdout per second, up to ${MAX_MB}MB`)
    await sbx.process.exec({ name: WRITER, command: WRITER_COMMAND, waitForCompletion: false })

    // Sample once a second until something breaks or the writer is done: RSS,
    // free memory, log dir size, and the size of a list response (the endpoint
    // that used to inline every process' whole output).
    let maxRss = first.rssMb
    let maxLogMb = first.logMb
    let maxListBytes = 0
    let minAvailableMb = first.availableMb
    let crash: string | undefined
    let writerDone = false
    const steps = Math.ceil(MAX_MB / STEP_MB) + 30

    for (let i = 0; i < steps && !crash && !writerDone; i++) {
      let listed: unknown
      try {
        listed = await sbx.process.list()
        maxListBytes = Math.max(maxListBytes, JSON.stringify(listed).length)
      } catch (err) {
        crash = `GET /process stopped answering: ${err}`
        break
      }

      let now: Probe
      try {
        now = await probe(sbx, pid)
      } catch (err) {
        crash = `the guest stopped answering probes (${err}) — ${await diagnose(sbx)}`
        break
      }

      maxRss = Math.max(maxRss, now.rssMb)
      maxLogMb = Math.max(maxLogMb, now.logMb)
      minAvailableMb = Math.min(minAvailableMb, now.availableMb)
      const known = Array.isArray(listed) ? listed.length : 0
      log(
        `  #${i + 1}: sandbox-api RSS=${now.rssMb.toFixed(1)}MB, available=${now.availableMb.toFixed(0)}MB, ` +
        `logs=${now.logMb.toFixed(1)}MB, list=${(JSON.stringify(listed).length / 1024).toFixed(0)}KB, ` +
        `${known} processes`,
      )

      crash = describeRestart(first, now)
      if (crash) break

      try {
        writerDone = (await sbx.process.get(WRITER)).status !== "running"
      } catch (err) {
        crash = `the API no longer knows about ${WRITER} (${err}) — ${await attribute(sbx, pid, first)}`
        break
      }
      await sleep(1000)
    }

    if (crash) {
      console.error(`[log-memory] CRASHED: ${crash}`)
    } else if (writerDone) {
      log(`The writer finished on its own after ~${MAX_MB}MB`)
    } else {
      log(`Stopped sampling after ${steps} steps`)
    }

    log(
      `sandbox-api RSS peak=${maxRss.toFixed(1)}MB (started at ${first.rssMb.toFixed(1)}MB), ` +
      `guest memory available fell to ${minAvailableMb.toFixed(0)}MB, ` +
      `log dir peak=${maxLogMb.toFixed(1)}MB, largest list response=${(maxListBytes / 1024).toFixed(0)}KB`,
    )

    check(
      crash === undefined,
      `the sandbox stayed up for the whole run`,
      `the sandbox did not survive the writes: ${crash}`,
    )
    check(
      maxRss <= MAX_API_RSS_MB,
      `sandbox-api RSS stayed at ${maxRss.toFixed(1)}MB (limit ${MAX_API_RSS_MB}MB)`,
      `sandbox-api RSS peaked at ${maxRss.toFixed(1)}MB (limit ${MAX_API_RSS_MB}MB) — ` +
      `it is holding process output in memory`,
    )
    check(
      maxLogMb <= MAX_LOG_DIR_MB,
      `process log files stayed at ${maxLogMb.toFixed(1)}MB of the guest tmpfs (limit ${MAX_LOG_DIR_MB}MB)`,
      `process log files use ${maxLogMb.toFixed(1)}MB of the guest tmpfs (limit ${MAX_LOG_DIR_MB}MB) — ` +
      `the per-file cap is not being enforced`,
    )
    const listLimitBytes = 3 * 256 * 1024
    check(
      maxListBytes <= listLimitBytes,
      `the largest GET /process response was ${(maxListBytes / 1024).toFixed(0)}KB ` +
      `(limit ${(listLimitBytes / 1024).toFixed(0)}KB)`,
      `the largest GET /process response was ${(maxListBytes / 1024).toFixed(0)}KB ` +
      `(limit ${(listLimitBytes / 1024).toFixed(0)}KB) — the list is inlining full logs`,
    )

    // What survived.
    let marker = ""
    try {
      marker = (await sbx.fs.read(MARKER)).trim()
    } catch (err) {
      marker = `unreadable (${err})`
    }
    check(
      marker === MARKER_CONTENT,
      `the tmpfs survived: ${MARKER} is still there`,
      `the tmpfs did not survive: ${MARKER} now reads ${JSON.stringify(marker)}`,
    )

    try {
      const logs = await sbx.process.logs(WRITER)
      check(
        logs.length > 0,
        `GET /process/${WRITER}/logs returned ${(logs.length / 1024).toFixed(0)}KB, read from disk`,
        `GET /process/${WRITER}/logs returned nothing — the output should be readable from disk`,
      )
    } catch (err) {
      check(false, "", `GET /process/${WRITER}/logs failed (${err}) — the API lost the process' output`)
    }

    // The OOM killer's victim must be the workload, not the API.
    try {
      const apiScore = await run(sbx, `cat /proc/${pid}/oom_score_adj`)
      check(
        parseInt(apiScore, 10) < 0,
        `sandbox-api is biased away from the OOM killer (oom_score_adj=${apiScore})`,
        `sandbox-api oom_score_adj=${apiScore}, want a negative value`,
      )

      await sbx.process.exec({ name: "victim", command: "sleep 60", waitForCompletion: false })
      const victim = await sbx.process.get("victim")
      const victimScore = await run(sbx, `cat /proc/${victim.pid}/oom_score_adj`)
      check(
        parseInt(victimScore, 10) > 0,
        `a process started through the API is the preferred victim (oom_score_adj=${victimScore})`,
        `a process started through the API has oom_score_adj=${victimScore}, want a positive value`,
      )
    } catch (err) {
      check(false, "", `could not read oom_score_adj (${err})`)
    }

    if (failures.length > 0) {
      throw new Error(`log-memory test FAILED:\n  - ${failures.join("\n  - ")}`)
    }
    log(`SUCCESS: sandbox-api stayed at ${maxRss.toFixed(1)}MB and the sandbox never restarted`)
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
