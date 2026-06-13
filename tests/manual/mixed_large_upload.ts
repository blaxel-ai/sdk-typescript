// Disable H2 to work around PM-2160 (h2 stream unref → event loop exits mid-await).
// Must be set BEFORE importing @blaxel/core.
process.env.BL_DISABLE_H2 = process.env.BL_DISABLE_H2 ?? "1"

import { DriveInstance, SandboxInstance, VolumeInstance, settings } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason)
})
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err)
  process.exit(1)
})
process.on("beforeExit", (code) => {
  console.error("[beforeExit] event loop empty, exiting with code", code)
})

const SOURCE_IMAGE = "blaxel/py-app:latest"
const RECEIVER_IMAGE = "blaxel/base-image:latest"
const LABEL_KEY = "created-by"
const LABEL_VAL = "mixed-large-upload-test"
const LABELS = { env: "manual-test", [LABEL_KEY]: LABEL_VAL }
const REGION = process.env.BL_REGION || "eu-dub-1"

const FILE_SIZE_GB = parseInt(process.env.FILE_SIZE_GB || "16", 10)
const TARGET_DRIVE_SIZE_GB = FILE_SIZE_GB + 4
const VOLUME_SIZE_MB = 50 * 1024 // 50 GB

const SOURCE_MEMORY_MB = 65536 // 64 GB
const RECEIVER_MEMORY_MB = 4096
const SRC_FILE = "/dev/shm/bigfile.bin"
const RECEIVER_VOLUME_PATH = "/tmp"        // volume (50 GB)
const RECEIVER_DRIVE_PATH = "/mnt/data"    // drive (upload destination)

const MOUNT_TIMEOUT_MS = 120_000
const EXEC_TIMEOUT_MS = 60_000
const MKFILE_TIMEOUT_MS = 10 * 60_000
const INSTALL_TIMEOUT_MS = 5 * 60_000
const UPLOAD_TIMEOUT_MS = 60 * 60_000

const UPLOAD_SCRIPT = `
import asyncio
import os
import sys
import time
from pathlib import Path

from blaxel.core import SandboxInstance

RECEIVER = os.environ["RECEIVER_NAME"]
SRC = os.environ["SRC_PATH"]
DEST = os.environ["DEST_PATH"]

def fmt_bytes(b):
    if b >= 1024 ** 3:
        return f"{b / 1024 ** 3:.2f} GB"
    if b >= 1024 ** 2:
        return f"{b / 1024 ** 2:.2f} MB"
    return f"{b / 1024:.2f} KB"

def free_mem_gb():
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    kb = int(line.split()[1])
                    return f"{kb / 1024 / 1024:.1f} GB"
    except Exception:
        pass
    return "?"

async def main():
    print(f"[sbx-upload] python: {sys.version.split()[0]}, free mem: {free_mem_gb()}", flush=True)
    print(f"[sbx-upload] BL_WORKSPACE: {os.environ.get('BL_WORKSPACE')}", flush=True)
    print(f"[sbx-upload] getting receiver sandbox: {RECEIVER}", flush=True)

    t0 = time.time()
    receiver = await SandboxInstance.get(RECEIVER)
    print(f"[sbx-upload] got receiver in {(time.time() - t0) * 1000:.0f} ms", flush=True)

    size = Path(SRC).stat().st_size
    print(f"[sbx-upload] src: {SRC}  size: {fmt_bytes(size)} ({size} bytes)", flush=True)

    print(f"[sbx-upload] calling receiver.fs.write_binary({DEST!r}, {SRC!r})", flush=True)
    t1 = time.time()
    await receiver.fs.write_binary(DEST, SRC)
    dt = time.time() - t1
    mbps = (size / 1024 ** 2) / dt if dt > 0 else 0
    print(f"[sbx-upload] DONE in {dt:.1f}s (~{mbps:.1f} MB/s)", flush=True)
    print(f"[sbx-upload] free mem after: {free_mem_gb()}", flush=True)

asyncio.run(main())
`

const REQUIREMENTS_TXT = "blaxel\n"

function uniqueName(prefix: string): string {
  return `${prefix}-${uuidv4().replace(/-/g, "").substring(0, 8)}`
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}min`
}

async function waitForEnter(prompt: string): Promise<void> {
  if (process.env.NO_PAUSE) {
    console.log(`\n${prompt}\n[NO_PAUSE set — skipping pause]`)
    return
  }
  process.stdout.write(`\n${prompt}\n>>> Press Enter to continue (or set NO_PAUSE=1 to skip): `)
  await new Promise<void>(resolve => {
    const onData = () => {
      process.stdin.removeListener("data", onData)
      process.stdin.pause()
      resolve()
    }
    process.stdin.resume()
    process.stdin.once("data", onData)
  })
}

async function getRemoteSize(sbx: SandboxInstance, path: string): Promise<number> {
  const result = await sbx.process.exec({
    command: `stat -c '%s' ${path} 2>/dev/null || echo 0`,
    waitForCompletion: true,
  })
  return parseInt(result.logs?.trim() ?? "0", 10) || 0
}

const SBX_PREFIXES = ["receiver-", "source-"]
const DRV_PREFIXES = ["tgt-drive-"]
const VOL_PREFIXES = ["tgt-volume-"]

function isOurs(name: string | undefined, labels: Record<string, string> | undefined, prefixes: string[]): boolean {
  if (labels?.[LABEL_KEY] === LABEL_VAL) return true
  if (!name) return false
  return prefixes.some(p => name.startsWith(p))
}

async function cleanupPrevious() {
  console.log("[pre-cleanup] scanning for leftover resources...")
  const [sandboxes, drives, volumes] = await Promise.all([
    SandboxInstance.list().catch(() => []),
    DriveInstance.list().catch(() => []),
    VolumeInstance.list().catch(() => []),
  ])

  const oldSbx = sandboxes.filter(s => isOurs(s.metadata?.name, s.metadata?.labels, SBX_PREFIXES))
  const oldDrv = drives.filter(d => isOurs(d.metadata?.name, d.metadata?.labels, DRV_PREFIXES))
  const oldVol = volumes.filter(v => isOurs(v.metadata?.name, v.metadata?.labels, VOL_PREFIXES))

  if (oldSbx.length + oldDrv.length + oldVol.length === 0) {
    console.log("[pre-cleanup] nothing to clean up")
    return
  }
  console.log(`[pre-cleanup] deleting ${oldSbx.length} sandbox(es) + ${oldDrv.length} drive(s) + ${oldVol.length} volume(s):`)
  for (const s of oldSbx) console.log(`  - sandbox: ${s.metadata?.name}`)
  for (const d of oldDrv) console.log(`  - drive:   ${d.metadata?.name}`)
  for (const v of oldVol) console.log(`  - volume:  ${v.metadata?.name}`)

  await Promise.all(oldSbx.map(s =>
    SandboxInstance.delete(s.metadata!.name!)
      .then(() => console.log(`[pre-cleanup] deleted sandbox: ${s.metadata?.name}`))
      .catch(e => console.error(`[pre-cleanup] could not delete sandbox ${s.metadata?.name}:`, e))
  ))
  // Wait for sandbox deletion before deleting attached volumes/drives
  await new Promise(r => setTimeout(r, 5000))
  await Promise.all([
    ...oldDrv.map(d =>
      DriveInstance.delete(d.metadata!.name!)
        .then(() => console.log(`[pre-cleanup] deleted drive: ${d.metadata?.name}`))
        .catch(e => console.error(`[pre-cleanup] could not delete drive ${d.metadata?.name}:`, e))
    ),
    ...oldVol.map(v =>
      VolumeInstance.delete(v.metadata!.name!)
        .then(() => console.log(`[pre-cleanup] deleted volume: ${v.metadata?.name}`))
        .catch(e => console.error(`[pre-cleanup] could not delete volume ${v.metadata?.name}:`, e))
    ),
  ])
}

async function main() {
  const apiKey = process.env.KEY
  if (!apiKey) throw new Error("KEY env var is required (e.g. KEY=bl_xxx ...)")
  if (!settings.workspace) throw new Error("BL_WORKSPACE must be set (or via ~/.blaxel/config.yaml)")

  await cleanupPrevious()

  const targetDriveName = uniqueName("tgt-drive")
  const targetVolumeName = uniqueName("tgt-volume")
  const receiverName = uniqueName("receiver")
  const sourceName = uniqueName("source")

  const createdSandboxes: string[] = []
  const createdDrives: string[] = []
  const createdVolumes: string[] = []

  const t0 = Date.now()
  console.log(`\n[setup] region=${REGION} fileSize=${FILE_SIZE_GB}GB`)
  console.log(`  source: ${SOURCE_MEMORY_MB}MB RAM, file lives in /dev/shm`)
  console.log(`  receiver: ${RECEIVER_MEMORY_MB}MB RAM`)
  console.log(`    volume (${VOLUME_SIZE_MB}MB = ${VOLUME_SIZE_MB / 1024}GB) → ${RECEIVER_VOLUME_PATH}`)
  console.log(`    drive  (${TARGET_DRIVE_SIZE_GB}GB)               → ${RECEIVER_DRIVE_PATH}  (upload destination)`)

  // 1. Create drive + volume in parallel
  console.log(`\n[setup] creating drive ${targetDriveName} + volume ${targetVolumeName}`)
  await Promise.all([
    DriveInstance.create({ name: targetDriveName, size: TARGET_DRIVE_SIZE_GB, region: REGION, labels: LABELS }),
    VolumeInstance.create({ name: targetVolumeName, size: VOLUME_SIZE_MB, region: REGION, labels: LABELS }),
  ])
  createdDrives.push(targetDriveName)
  createdVolumes.push(targetVolumeName)

  // 2. Sandboxes — receiver attaches the volume at /tmp via volumes:[] at create time
  console.log(`\n[setup] creating sandboxes: source=${sourceName} receiver=${receiverName}`)
  const [sourceSbx, receiverSbx] = await Promise.all([
    SandboxInstance.create({ name: sourceName, image: SOURCE_IMAGE, memory: SOURCE_MEMORY_MB, region: REGION, labels: LABELS }),
    SandboxInstance.create({
      name: receiverName,
      image: RECEIVER_IMAGE,
      memory: RECEIVER_MEMORY_MB,
      region: REGION,
      labels: LABELS,
      volumes: [{ name: targetVolumeName, mountPath: RECEIVER_VOLUME_PATH, readOnly: false }],
    }),
  ])
  createdSandboxes.push(sourceName, receiverName)

  // 3. Warm up + procps for source diagnostics
  await Promise.all([
    withTimeout(sourceSbx.process.exec({ command: "echo ready", waitForCompletion: true }), 60_000, "source warmup"),
    withTimeout(receiverSbx.process.exec({ command: "echo ready", waitForCompletion: true }), 60_000, "receiver warmup"),
  ])
  console.log(`[setup] sandboxes ready in ${fmt(Date.now() - t0)}`)

  console.log(`[setup] installing procps on source sandbox`)
  await sourceSbx.process.exec({
    command: "command -v free >/dev/null || (apt-get update -qq && apt-get install -y -qq procps) >/dev/null 2>&1; command -v free && echo OK || echo MISSING",
    waitForCompletion: true,
  })

  // 4. Mount drive on receiver at /mnt/data (volume already mounted via spec)
  console.log(`\n[mount] receiver: mounting drive ${targetDriveName} → ${RECEIVER_DRIVE_PATH}`)
  await receiverSbx.process.exec({ command: `mkdir -p ${RECEIVER_DRIVE_PATH}`, waitForCompletion: true }).catch(() => {})
  const driveMountResult = await withTimeout(
    receiverSbx.drives.mount({ driveName: targetDriveName, mountPath: RECEIVER_DRIVE_PATH }),
    MOUNT_TIMEOUT_MS, "receiver drive mount"
  )
  console.log(`[mount] drive mount API returned:`, driveMountResult)

  // Verify both mounts on the receiver
  const mountCheck = await receiverSbx.process.exec({
    command: [
      `echo '--- mounts:'`,
      `mount | grep -E '${RECEIVER_VOLUME_PATH}|${RECEIVER_DRIVE_PATH}|blfs|fuse|/dev/(vd|sd|xvd|nvme)' || true`,
      `echo '--- df:'`,
      `df -h ${RECEIVER_VOLUME_PATH} ${RECEIVER_DRIVE_PATH} 2>&1 || true`,
      `echo '--- ls volume:'`,
      `ls -la ${RECEIVER_VOLUME_PATH}`,
      `echo '--- ls drive:'`,
      `ls -la ${RECEIVER_DRIVE_PATH}`,
    ].join(" ; "),
    waitForCompletion: true,
  })
  console.log(`[mount] verification on receiver:\n${mountCheck.logs ?? "(no output)"}`)

  // 5. mkfile on source's tmpfs
  const srcFile = SRC_FILE
  console.log(`\n[mkfile] checking source memory & tmpfs`)
  const envCheck = await sourceSbx.process.exec({
    command: "uname -a ; free -h ; df -h /dev/shm",
    waitForCompletion: true,
  })
  console.log(envCheck.logs ?? "(no env output)")

  console.log(`[mkfile] dd if=/dev/zero of=${srcFile} bs=1M count=${FILE_SIZE_GB * 1024}`)
  const mk = Date.now()
  const expectedBytes = FILE_SIZE_GB * 1024 ** 3
  const mkResult = await withTimeout(
    sourceSbx.process.exec({
      command: `dd if=/dev/zero of=${srcFile} bs=1M count=${FILE_SIZE_GB * 1024} status=none && stat -c '%s' ${srcFile}`,
      waitForCompletion: true,
    }),
    MKFILE_TIMEOUT_MS, "dd write"
  )
  if (mkResult.exitCode !== 0) {
    throw new Error(`dd failed (exit ${mkResult.exitCode}): ${mkResult.logs}`)
  }
  const fileSize = await getRemoteSize(sourceSbx, srcFile)
  if (fileSize !== expectedBytes) {
    throw new Error(`file size mismatch: ${fileSize}B != ${expectedBytes}B`)
  }
  console.log(`[mkfile] wrote ${(fileSize / 1024 ** 3).toFixed(2)} GB in ${fmt(Date.now() - mk)}`)

  // 6. Install blaxel SDK + write upload script on source
  console.log(`\n[install] preparing source sandbox`)
  await sourceSbx.fs.write("/root/upload/requirements.txt", REQUIREMENTS_TXT)
  await sourceSbx.fs.write("/root/upload/upload.py", UPLOAD_SCRIPT)

  const tInst = Date.now()
  const inst = await withTimeout(
    sourceSbx.process.exec({
      command: "cd /root/upload && pip install --quiet --disable-pip-version-check blaxel 2>&1",
      waitForCompletion: true,
    }),
    INSTALL_TIMEOUT_MS, "pip install"
  )
  if (inst.exitCode !== 0) {
    console.error(inst.logs)
    throw new Error(`pip install failed (exit ${inst.exitCode})`)
  }
  console.log(`[install] done in ${fmt(Date.now() - tInst)}`)

  // 7. Start background upload + stream logs + poll receiver/source state
  const destPath = `${RECEIVER_DRIVE_PATH}/bigfile.bin`

  await waitForEnter(`[step] setup done — about to start SDK upload to receiver:${destPath}\n  source:   ${sourceName}\n  receiver: ${receiverName}\n  volume:   ${targetVolumeName} → ${RECEIVER_VOLUME_PATH}\n  drive:    ${targetDriveName} → ${RECEIVER_DRIVE_PATH}  (destination)`)

  console.log(`\n[upload] starting background SDK upload from source → receiver:${destPath}`)
  const envVars = [
    `BL_API_KEY='${apiKey}'`,
    `BL_WORKSPACE='${settings.workspace}'`,
    `BL_REGION='${REGION}'`,
    `RECEIVER_NAME='${receiverName}'`,
    `SRC_PATH='${SRC_FILE}'`,
    `DEST_PATH='${destPath}'`,
  ].join(" ")

  const procName = `upload-${Date.now()}`
  const tUp = Date.now()
  let uploadError: Error | null = null

  const startResult = await sourceSbx.process.exec({
    name: procName,
    command: `cd /root/upload && ${envVars} python3 -u upload.py 2>&1`,
  })
  console.log(`[upload] started: pid=${(startResult as { pid?: string }).pid ?? "?"} name=${procName}`)

  const logStream = sourceSbx.process.streamLogs(procName, {
    onLog: line => process.stdout.write(`  [source] ${line}\n`),
    onError: err => console.error(`  [source][stream-err] ${err.message}`),
  })

  const pollStart = Date.now()
  let lastSourceStatus = "running"
  while (Date.now() - pollStart < UPLOAD_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, 10_000))
    const info = await sourceSbx.process.get(procName).catch(() => null)
    lastSourceStatus = info?.status ?? "unknown"
    const ping = await receiverSbx.process.exec({ command: "echo alive", waitForCompletion: true }).catch(() => null)
    const receiverAlive = ping?.logs?.trim() === "alive"
    const usage = await receiverSbx.process.exec({
      command: `df -h ${RECEIVER_DRIVE_PATH} ${RECEIVER_VOLUME_PATH} 2>/dev/null | awk 'NR>1 {print $6": "$3"/"$2}' | xargs`,
      waitForCompletion: true,
    }).catch(() => null)
    console.log(`[poll t=${fmt(Date.now() - pollStart)}] source-proc=${lastSourceStatus} receiver=${receiverAlive ? "alive" : "DOWN"} usage=${usage?.logs?.trim() ?? "?"}`)
    if (lastSourceStatus !== "running") break
  }

  logStream.close()
  await logStream.wait().catch(() => {})

  const finalInfo = await sourceSbx.process.get(procName).catch(() => null)
  const finalExitCode = (finalInfo as { exitCode?: number } | null)?.exitCode
  console.log(`[upload] final source status=${finalInfo?.status ?? "?"} exitCode=${finalExitCode ?? "?"}`)

  if (lastSourceStatus === "running") {
    uploadError = new Error(`upload still running after ${fmt(UPLOAD_TIMEOUT_MS)} timeout`)
  } else if (finalInfo?.status !== "completed" || (finalExitCode !== undefined && finalExitCode !== 0)) {
    uploadError = new Error(`upload failed: status=${finalInfo?.status} exitCode=${finalExitCode}`)
  }

  if (!uploadError) {
    console.log(`[upload] SUCCESS in ${fmt(Date.now() - tUp)}`)
  } else {
    console.error(`[upload] FAILED after ${fmt(Date.now() - tUp)}: ${uploadError.message}`)
  }

  // 8. Verify receiver health + file
  console.log(`\n[verify] checking receiver sandbox`)
  const ping = await receiverSbx.process.exec({ command: "echo alive", waitForCompletion: true }).catch(() => null)
  console.log(`[verify] receiver alive: ${ping?.logs?.trim() === "alive" ? "yes" : "NO / unreachable"}`)

  if (!uploadError) {
    const vstat = await receiverSbx.process.exec({ command: `stat -c '%s' ${destPath}`, waitForCompletion: true }).catch(() => null)
    const received = parseInt(vstat?.logs?.trim() ?? "0", 10)
    const match = received === fileSize
    console.log(`[verify] file size on receiver: ${(received / 1024 ** 3).toFixed(2)} GB — ${match ? "match" : `MISMATCH (expected ${fileSize})`}`)
  }

  console.log(`\n=== Summary ===`)
  console.log(`  Region:       ${REGION}`)
  console.log(`  File size:    ${FILE_SIZE_GB} GB`)
  console.log(`  Source mem:   ${SOURCE_MEMORY_MB} MB`)
  console.log(`  Receiver mem: ${RECEIVER_MEMORY_MB} MB`)
  console.log(`  Volume:       ${VOLUME_SIZE_MB / 1024} GB @ ${RECEIVER_VOLUME_PATH}`)
  console.log(`  Drive:        ${TARGET_DRIVE_SIZE_GB} GB @ ${RECEIVER_DRIVE_PATH}  (upload destination)`)
  console.log(`  Total time:   ${fmt(Date.now() - t0)}`)
  console.log(`  Result:       ${uploadError ? `FAILED — ${uploadError.message}` : "SUCCESS"}`)

  console.log(`\n[leaving resources alive — next run's pre-cleanup will delete them]`)
  console.log(`  sandboxes: ${createdSandboxes.join(", ")}`)
  console.log(`  drives:    ${createdDrives.join(", ")}`)
  console.log(`  volumes:   ${createdVolumes.join(", ")}`)
}

main().catch(err => {
  console.error("Fatal error:", err)
  process.exit(1)
})
