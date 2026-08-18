// Manual test: OOM crash recovery preserves files on disk.
//
// Verifies the mk3.1 crash-recovery behavior (executionplane#556): when the
// workload inside a sandbox is OOM-killed, the guest relaunches it IN PLACE
// (VM stays up, tmpfs files survive, boot_id unchanged); only if that fails
// does the microVM cold-reboot with disk-backed storage preserved.
//
// Flow:
//   1. Create a sandbox with a small memory limit.
//   2. Write marker files on disk and read them back.
//   3. Run a single process that grows its memory until the guest OOMs.
//   4. Wait for the crash + automatic restart. Two signals, either counts:
//      - in-guest restart: sandbox-api is relaunched, so its process table
//        resets and the oom-hog record disappears (boot_id unchanged);
//      - cold VM reboot: /proc/sys/kernel/random/boot_id changes.
//   5. Verify the sandbox answers again and the files are intact.
//   6. Log lastCrashAt/lastCrashReason from the API if present.
//
// Run (after `npm run build` in @blaxel/core):
//
//   npx tsx tests/manual/oom_crash_recovery.ts
//
// Env vars:
//   NAME                sandbox name (default: oomtest-<random>)
//   IMAGE               sandbox image (default blaxel/base-image:latest)
//   REGION              region to create the sandbox in (optional)
//   MEMORY_MB           sandbox memory in MB (default 1024)
//   FILES               number of marker files to write (default 5)
//   RESTART_TIMEOUT_MS  how long to wait for the crash + restart (default 300000)
//   POLL_MS             poll interval while waiting for the restart (default 3000)
//   CLEANUP             delete the sandbox at the end (default "true")

// Disable H2 to work around PM-2160 (h2 stream unref -> event loop exits mid-await).
// Must be set BEFORE importing @blaxel/core.
process.env.BL_DISABLE_H2 = process.env.BL_DISABLE_H2 ?? "1"

import { SandboxInstance, settings } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason)
})

const NAME = process.env.NAME || `oomtest-${uuidv4().replace(/-/g, "").substring(0, 8)}`
const IMAGE = process.env.IMAGE || "blaxel/base-image:latest"
const REGION = process.env.REGION
const MEMORY_MB = parseInt(process.env.MEMORY_MB || "1024", 10)
const FILES = parseInt(process.env.FILES || "5", 10)
const RESTART_TIMEOUT_MS = parseInt(process.env.RESTART_TIMEOUT_MS || "300000", 10)
const POLL_MS = parseInt(process.env.POLL_MS || "3000", 10)
const CLEANUP = (process.env.CLEANUP ?? "true") === "true"
const LABELS = { env: "manual-test", "created-by": "oom-crash-recovery" }

const TEST_DIR = "/home/user/oom-test"
const EXEC_TIMEOUT_S = 60

// Fill tmpfs with zeros to exhaust guest memory. /dev/shm is RAM-backed and its
// pages are unreclaimable (no swap in the guest), so this is real memory
// pressure and the kernel OOM-killer fires on the largest RSS process.
// Remounting lifts the default size cap of 50% of RAM.
//
// Rejected alternatives:
//   - a fork bomb only exhausts the PID table (fork returns EAGAIN, no OOM) and
//     blocks the test's own boot_id probe from forking;
//   - growing a shell variable (`s=$s$s`) makes dash hit its internal
//     allocation limit and exit cleanly, so the kernel never sees pressure.
const OOM_COMMAND =
  "sh -c 'echo start; mount -o remount,size=100% /dev/shm 2>/dev/null; dd if=/dev/zero of=/dev/shm/oomfill bs=1M'"

function log(msg: string) {
  console.log(`[oom-recovery] ${msg}`)
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

async function bootId(sbx: SandboxInstance): Promise<string> {
  return await run(sbx, "cat /proc/sys/kernel/random/boot_id", "read boot_id")
}

type MarkerFile = { path: string; content: string }

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

  let failed = false
  try {
    const bootBefore = await bootId(sbx)
    log(`Sandbox up. boot_id=${bootBefore}`)

    // 1. Create files on disk
    log(`Writing ${FILES} marker files under ${TEST_DIR}`)
    const files: MarkerFile[] = []
    for (let i = 0; i < FILES; i++) {
      const path = `${TEST_DIR}/marker-${i}.txt`
      const content = `marker ${i} ${uuidv4()} written before OOM at ${new Date().toISOString()}\n`
      await sbx.fs.write(path, content)
      files.push({ path, content })
    }
    for (const f of files) {
      const readBack = await sbx.fs.read(f.path)
      if (readBack !== f.content) {
        throw new Error(`Pre-crash read-back mismatch for ${f.path}`)
      }
    }
    log(`All ${FILES} files written and verified`)

    // 2. Trigger the OOM
    log(`Starting memory hog (${OOM_COMMAND})`)
    await sbx.process.exec({
      name: "oom-hog",
      command: OOM_COMMAND,
      waitForCompletion: false,
    })

    // 3. Wait for the crash + automatic restart. An in-guest restart keeps the
    // same boot_id, so a changed boot_id is only the cold-reboot fallback; the
    // primary signal is sandbox-api's process table resetting (oom-hog record
    // gone) while the API answers again.
    log(`Waiting for crash + restart (timeout ${Math.round(RESTART_TIMEOUT_MS / 1000)}s)...`)
    const start = Date.now()
    let restartKind: "in-guest" | "vm-reboot" | null = null
    let sawUnreachable = false
    while (Date.now() - start < RESTART_TIMEOUT_MS) {
      await sleep(POLL_MS)
      try {
        const current = await bootId(sbx)
        if (current !== bootBefore) {
          restartKind = "vm-reboot"
          log(`Cold VM reboot detected: boot_id ${bootBefore} -> ${current}`)
          break
        }
        let hogGone = false
        let hogStatus: string | undefined
        try {
          const hog = await sbx.process.get("oom-hog")
          hogStatus = hog.status
        } catch {
          hogGone = true
        }
        if (hogGone) {
          restartKind = "in-guest"
          log(`In-guest restart detected: boot_id unchanged, process table reset (oom-hog record gone)`)
          break
        }
        log(`  still on original boot, oom-hog status=${hogStatus} (${Math.round((Date.now() - start) / 1000)}s elapsed)`)
      } catch (err: unknown) {
        sawUnreachable = true
        const msg = err instanceof Error ? err.message : String(err)
        log(`  sandbox unreachable (crash/restart in progress): ${msg.split("\n")[0]}`)
      }
    }
    if (!restartKind) {
      throw new Error(
        `Sandbox did not restart within ${RESTART_TIMEOUT_MS}ms ` +
        `(unreachable at some point: ${sawUnreachable})`,
      )
    }
    log(`Restart (${restartKind}) detected after ${Math.round((Date.now() - start) / 1000)}s`)

    // 4. Verify files survived on disk
    log(`Verifying files after restart`)
    let intact = 0
    for (const f of files) {
      const readBack = await sbx.fs.read(f.path)
      if (readBack === f.content) {
        intact++
      } else {
        failed = true
        console.error(`[oom-recovery] FILE LOST OR CORRUPTED: ${f.path}`)
      }
    }
    log(`${intact}/${files.length} files intact after OOM restart`)

    // 5. Processes must NOT survive the restart
    try {
      const hog = await sbx.process.get("oom-hog")
      if (hog.status === "running") {
        failed = true
        console.error(`[oom-recovery] UNEXPECTED: oom-hog still running after restart`)
      } else {
        log(`oom-hog process is not running anymore (status=${hog.status})`)
      }
    } catch {
      log(`oom-hog process is gone after restart (expected)`)
    }

    // 6. Crash info from the API (requires the controlplane crash-signal change
    // to be deployed; the event is pushed asynchronously so it may lag by a minute)
    try {
      const res = await globalThis.fetch(`${settings.baseUrl}/sandboxes/${NAME}`, {
        headers: settings.headers,
      })
      if (res.ok) {
        const record = await res.json() as Record<string, unknown>
        const lastCrashAt = record["lastCrashAt"]
        const lastCrashReason = record["lastCrashReason"]
        if (lastCrashAt || lastCrashReason) {
          log(`API crash info: lastCrashAt=${String(lastCrashAt)} lastCrashReason=${String(lastCrashReason)}`)
        } else {
          log(`API crash info not present yet (event may still be in flight, or controlplane change not deployed)`)
        }
      }
    } catch (err) {
      log(`Could not fetch sandbox record for crash info: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (failed || intact !== files.length) {
      throw new Error(
        `OOM crash recovery test FAILED: some files were lost (recovery was ${restartKind}; ` +
        `a diskless sandbox only keeps its files across an in-guest restart)`,
      )
    }
    log(`SUCCESS: sandbox restarted (${restartKind}) after OOM and all files survived`)
  } finally {
    if (CLEANUP) {
      log(`Deleting sandbox ${NAME}`)
      try { await SandboxInstance.delete(NAME) } catch (err) {
        console.error(`[oom-recovery] cleanup failed:`, err)
      }
    } else {
      log(`CLEANUP=false — sandbox ${NAME} left running`)
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[oom-recovery] FAILED:", err)
    process.exit(1)
  },
)
