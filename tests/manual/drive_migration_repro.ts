/**
 * Reproducer for Agent Drive migration flakiness (signed S3 transfers + copy).
 *
 * Mirrors the quest single-drive migration flow, in parallel, multiple times:
 *   1. A source sandbox generates random data, archives it (workspace.tar.gz)
 *      and records sha256 checksums.
 *   2. The source sandbox uploads the archive to the drive via the
 *      S3-compatible endpoint (curl PUT, Bearer drive token, 5 retries with
 *      incremental backoff — same as the migration).
 *   3. The archive is copied to another folder via S3 server-side copy
 *      (PUT + x-amz-copy-source), from inside the source sandbox.
 *   4. A fresh destination sandbox downloads the copied object (curl GET,
 *      5 retries), verifies the archive sha256, unarchives it and verifies
 *      the content manifest sha256.
 *
 * Every step records curl exit codes / HTTP statuses / checksums so failures
 * can be classified: upload-network, copy, download-network, archive
 * corruption, content corruption.
 *
 * Environment variables:
 *   BL_WORKSPACE     — workspace name (standard SDK auth)
 *   BL_API_KEY       — API key (standard SDK auth)
 *   BL_ENV           — "dev" or "prod" (default: "dev")
 *   BL_DRIVE_REGION  — drive region override (default: eu-dub-1 dev, us-was-1 prod)
 *   ITERATIONS       — total migrations to run (default: 10)
 *   CONCURRENCY      — how many run in parallel (default: 5)
 *   FILE_MB          — size of random payload in MB (default: random 5-15MB per
 *                      iteration, matching real migration archive sizes)
 *   KEEP             — set to "1" to keep drive + sandboxes for inspection
 *
 * Usage:
 *   npx tsx tests/manual/drive_migration_repro.ts
 *   ITERATIONS=30 CONCURRENCY=30 FILE_MB=100 npx tsx tests/manual/drive_migration_repro.ts
 */

import { DriveInstance, SandboxInstance, settings } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ENV = process.env.BL_ENV || "dev"
const REGION = process.env.BL_DRIVE_REGION || (ENV === "dev" ? "eu-dub-1" : "us-was-1")
const IMAGE = "blaxel/base-image:latest"
const LABELS = { env: "manual-test", "created-by": "drive-migration-repro" }

const ITERATIONS = parseInt(process.env.ITERATIONS || "10", 10)
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "5", 10)
// Real migration archives are 5-15 MB; default picks a random size per iteration.
const FILE_MB = process.env.FILE_MB ? parseInt(process.env.FILE_MB, 10) : 0
function payloadMb(): number {
  return FILE_MB > 0 ? FILE_MB : 5 + Math.floor(Math.random() * 11)
}
const KEEP = process.env.KEEP === "1"

const CURL_RETRIES = 5
const CURL_MAX_TIME_S = 120
const EXEC_TIMEOUT_MS = 10 * 60_000
const RUN_ID = uuidv4().replace(/-/g, "").substring(0, 8)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid(prefix: string): string {
  return `${prefix}-${uuidv4().replace(/-/g, "").substring(0, 8)}`
}

function ts(): string {
  return new Date().toISOString()
}

function log(iter: number, msg: string) {
  console.log(`[${ts()}] [it-${String(iter).padStart(2, "0")}] ${msg}`)
}

// Serialize any thrown value (Error, API error object, string) with full detail.
function formatError(err: unknown): string {
  if (err instanceof Error) {
    const extra = JSON.stringify(err, Object.getOwnPropertyNames(err).filter((k) => k !== "stack"))
    return extra !== "{}" ? `${err.message} ${extra}` : err.message
  }
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e: unknown) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(formatError(e))) },
    )
  })
}

async function ensureCurl(sbx: SandboxInstance): Promise<void> {
  const r = await exec(sbx, `command -v curl >/dev/null || { command -v apk >/dev/null && apk add --no-cache curl || { apt-get update -qq && apt-get install -y -qq curl; }; } >/dev/null 2>&1; command -v curl`)
  if (r.exitCode !== 0) throw new Error(`curl unavailable in sandbox: ${r.logs}`)
}

async function exec(sbx: SandboxInstance, command: string, timeoutMs = EXEC_TIMEOUT_MS): Promise<{ exitCode: number; logs: string }> {
  const result = await withTimeout(
    sbx.process.exec({ command: `bash -c ${shellQuote(command)}`, waitForCompletion: true }),
    timeoutMs,
    `exec: ${command.substring(0, 80)}`,
  )
  return { exitCode: result.exitCode ?? -1, logs: result.logs ?? "" }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Fetch a fresh drive access token via the control plane (standard SDK auth).
async function getDriveToken(driveName: string): Promise<string> {
  const res = await fetch(`${settings.baseUrl}/drives/${driveName}/access-token`, {
    method: "POST",
    headers: settings.headers,
  })
  if (!res.ok) throw new Error(`access-token request failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { access_token?: string }
  if (!body.access_token) throw new Error(`access-token response missing token: ${JSON.stringify(body)}`)
  return body.access_token
}

// curl loop replicating the migration's 5 incremental retries.
// Emits one "ATTEMPT n curl=<code> http=<status>" line per attempt.
function curlRetryScript(args: string, outVar: string, output = "/dev/null"): string {
  return `
rc=1
for attempt in 1 2 3 4 5; do
  http=$(curl -sS -o ${output} -w '%{http_code}' -m ${CURL_MAX_TIME_S} ${args} 2>/tmp/curl_err_${outVar}); rc=$?
  echo "ATTEMPT_${outVar} $attempt curl=$rc http=$http err=$(head -c 200 /tmp/curl_err_${outVar} | tr '\\n' ' ')"
  if [ "$rc" = "0" ] && [ "$http" -ge 200 ] && [ "$http" -lt 300 ]; then break; fi
  rc=1
  sleep $((attempt * 2))
done
[ "$rc" = "0" ] || echo "FAILED_${outVar}"
`
}

// ---------------------------------------------------------------------------
// Per-iteration result
// ---------------------------------------------------------------------------

type StepResult = { ok: boolean; detail: string; attempts?: string[] }

type IterationResult = {
  iter: number
  classification: string
  steps: Record<string, StepResult>
  durationMs: number
}

function extractAttempts(logs: string, tag: string): string[] {
  return logs.split("\n").filter((l) => l.startsWith(`ATTEMPT_${tag} `))
}

// ---------------------------------------------------------------------------
// One migration iteration
// ---------------------------------------------------------------------------

async function runIteration(iter: number, driveName: string, s3Url: string, bucket: string): Promise<IterationResult> {
  const t0 = Date.now()
  const steps: Record<string, StepResult> = {}
  const srcName = uid(`repro-src-${RUN_ID}-${iter}`)
  const dstName = uid(`repro-dst-${RUN_ID}-${iter}`)
  const srcKey = `.repro/${RUN_ID}/${iter}/src/workspace.tar.gz`
  const dstKey = `.repro/${RUN_ID}/${iter}/dst/workspace.tar.gz`
  let classification = "OK"
  const sandboxes: string[] = []

  const fileMb = payloadMb()
  const finish = (): IterationResult => ({ iter, classification, steps, durationMs: Date.now() - t0 })

  try {
    // 1. Source sandbox + random payload + archive + checksums
    log(iter, `creating source sandbox ${srcName} (payload ${fileMb}MB)`)
    const src = await SandboxInstance.create({ name: srcName, image: IMAGE, memory: 2048, region: REGION, labels: LABELS }, { safe: true })
    sandboxes.push(srcName)
    await ensureCurl(src)

    const gen = await exec(src, `
set -e
mkdir -p /tmp/payload
for i in $(seq 1 5); do head -c $((${fileMb} * 1024 * 1024 / 5)) /dev/urandom > /tmp/payload/file_$i.bin; done
cd /tmp/payload && sha256sum file_* > /tmp/manifest.sha256
tar -czf /tmp/workspace.tar.gz -C /tmp payload manifest.sha256
sha256sum /tmp/workspace.tar.gz | awk '{print "ARCHIVE_SHA=" $1}'
stat -c 'ARCHIVE_SIZE=%s' /tmp/workspace.tar.gz
`)
    const archiveSha = gen.logs.match(/ARCHIVE_SHA=([0-9a-f]{64})/)?.[1]
    const archiveSize = gen.logs.match(/ARCHIVE_SIZE=(\d+)/)?.[1]
    steps.generate = { ok: gen.exitCode === 0 && !!archiveSha, detail: `sha=${archiveSha} size=${archiveSize}` }
    if (!steps.generate.ok) { classification = "SETUP_FAIL"; return finish() }
    log(iter, `payload ready sha=${archiveSha?.substring(0, 12)} size=${archiveSize}`)

    // 2. Signed S3 PUT from inside the source sandbox
    const token = await getDriveToken(driveName)
    const put = await exec(src, curlRetryScript(
      `-X PUT -H "Authorization: Bearer ${token}" -T /tmp/workspace.tar.gz "${s3Url}/${srcKey}"`,
      "PUT",
    ))
    steps.upload = { ok: !put.logs.includes("FAILED_PUT"), detail: put.logs.trim().split("\n").pop() ?? "", attempts: extractAttempts(put.logs, "PUT") }
    log(iter, `upload ${steps.upload.ok ? "OK" : "FAILED"} (${steps.upload.attempts?.length} attempts)`)
    if (!steps.upload.ok) { classification = "UPLOAD_NETWORK_FAIL"; return finish() }

    // 3. S3 server-side copy src -> dst (from inside the source sandbox)
    const copy = await exec(src, curlRetryScript(
      `-X PUT -H "Authorization: Bearer ${token}" -H "x-amz-copy-source: /${bucket}/${srcKey}" "${s3Url}/${dstKey}"`,
      "COPY",
    ))
    steps.copy = { ok: !copy.logs.includes("FAILED_COPY"), detail: copy.logs.trim().split("\n").pop() ?? "", attempts: extractAttempts(copy.logs, "COPY") }
    log(iter, `copy ${steps.copy.ok ? "OK" : "FAILED"} (${steps.copy.attempts?.length} attempts)`)
    if (!steps.copy.ok) { classification = "COPY_FAIL"; return finish() }

    // 4. Destination sandbox: signed GET + verify + unarchive + verify content
    log(iter, `creating destination sandbox ${dstName}`)
    const dst = await SandboxInstance.create({ name: dstName, image: IMAGE, memory: 2048, region: REGION, labels: LABELS }, { safe: true })
    sandboxes.push(dstName)
    await ensureCurl(dst)

    const dlToken = await getDriveToken(driveName)
    const get = await exec(dst, curlRetryScript(
      `-H "Authorization: Bearer ${dlToken}" "${s3Url}/${dstKey}"`,
      "GET",
      "/tmp/downloaded.tar.gz",
    ))
    steps.download = { ok: !get.logs.includes("FAILED_GET"), detail: get.logs.trim().split("\n").pop() ?? "", attempts: extractAttempts(get.logs, "GET") }
    log(iter, `download ${steps.download.ok ? "OK" : "FAILED"} (${steps.download.attempts?.length} attempts)`)
    if (!steps.download.ok) { classification = "DOWNLOAD_NETWORK_FAIL"; return finish() }

    const verify = await exec(dst, `
set -e
dl_sha=$(sha256sum /tmp/downloaded.tar.gz | awk '{print $1}')
dl_size=$(stat -c '%s' /tmp/downloaded.tar.gz)
echo "DL_SHA=$dl_sha DL_SIZE=$dl_size"
if [ "$dl_sha" != "${archiveSha}" ]; then echo "ARCHIVE_MISMATCH"; exit 0; fi
mkdir -p /tmp/extracted && tar -xzf /tmp/downloaded.tar.gz -C /tmp/extracted || { echo "UNTAR_FAIL"; exit 0; }
cd /tmp/extracted/payload && sha256sum -c ../manifest.sha256 >/dev/null 2>&1 && echo "CONTENT_OK" || echo "CONTENT_MISMATCH"
`)
    const vlogs = verify.logs
    if (vlogs.includes("ARCHIVE_MISMATCH")) {
      classification = "ARCHIVE_CORRUPTION"
      steps.verify = { ok: false, detail: `expected sha=${archiveSha}, got ${vlogs.match(/DL_SHA=(\S+) DL_SIZE=(\S+)/)?.[0] ?? vlogs.trim()}` }
    } else if (vlogs.includes("UNTAR_FAIL") || vlogs.includes("CONTENT_MISMATCH")) {
      classification = "CONTENT_CORRUPTION"
      steps.verify = { ok: false, detail: vlogs.trim().split("\n").slice(-3).join(" | ") }
    } else if (vlogs.includes("CONTENT_OK")) {
      steps.verify = { ok: true, detail: vlogs.match(/DL_SHA=\S+ DL_SIZE=\S+/)?.[0] ?? "content verified" }
    } else {
      classification = "VERIFY_INCONCLUSIVE"
      steps.verify = { ok: false, detail: `exit=${verify.exitCode} logs=${vlogs.trim().split("\n").slice(-3).join(" | ")}` }
    }
    log(iter, `verify ${steps.verify.ok ? "OK" : `FAILED (${classification})`}: ${steps.verify.detail}`)
    return finish()
  } catch (err) {
    classification = "INFRA_FAIL"
    steps.infra = { ok: false, detail: formatError(err) }
    log(iter, `INFRA_FAIL: ${steps.infra.detail}`)
    return finish()
  } finally {
    if (!KEEP) {
      for (const name of sandboxes) {
        await SandboxInstance.delete(name).catch(() => {})
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!settings.workspace) throw new Error("BL_WORKSPACE must be set (or via ~/.blaxel/config.yaml)")
  console.log(`run=${RUN_ID} env=${ENV} region=${REGION} workspace=${settings.workspace}`)
  console.log(`iterations=${ITERATIONS} concurrency=${CONCURRENCY} payload=${FILE_MB > 0 ? `${FILE_MB}MB` : "random 5-15MB"} curlRetries=${CURL_RETRIES}`)

  const driveName = `repro-drive-${RUN_ID}`
  console.log(`[${ts()}] creating drive ${driveName}`)
  const drive = await DriveInstance.create({ name: driveName, size: Math.max(10, Math.ceil((ITERATIONS * Math.max(FILE_MB, 15) * 2) / 1024) + 5), region: REGION, labels: LABELS })
  const s3UrlMaybe = drive.state?.s3Url
  if (s3UrlMaybe === undefined || s3UrlMaybe === "") throw new Error(`drive has no s3Url in state: ${JSON.stringify(drive.state)}`)
  const s3Url: string = s3UrlMaybe
  const urlPath = new URL(s3Url).pathname.split("/").filter(Boolean)
  if (urlPath.length === 0) throw new Error(`cannot extract bucket from s3Url: ${s3Url}`)
  const bucket = urlPath[0]
  console.log(`[${ts()}] drive ready: s3Url=${s3Url} bucket=${bucket}`)

  const results: IterationResult[] = []
  let next = 0
  async function worker() {
    while (next < ITERATIONS) {
      const iter = next++
      results.push(await runIteration(iter, driveName, s3Url, bucket))
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ITERATIONS) }, () => worker()))

  // Summary
  console.log(`\n=== Summary (run=${RUN_ID}) ===`)
  const counts: Record<string, number> = {}
  for (const r of results.sort((a, b) => a.iter - b.iter)) {
    counts[r.classification] = (counts[r.classification] || 0) + 1
    const stepStr = Object.entries(r.steps).map(([k, v]) => `${k}=${v.ok ? "ok" : "FAIL"}`).join(" ")
    console.log(`  it-${String(r.iter).padStart(2, "0")}  ${r.classification.padEnd(24)} ${(r.durationMs / 1000).toFixed(0)}s  ${stepStr}`)
  }
  console.log(`\n  Totals: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join("  ")}`)

  // Failure detail dump (attempt lines carry curl exit codes + HTTP statuses)
  const failures = results.filter((r) => r.classification !== "OK")
  if (failures.length > 0) {
    console.log(`\n=== Failure details ===`)
    for (const r of failures) {
      console.log(`\nit-${String(r.iter).padStart(2, "0")} — ${r.classification}`)
      for (const [step, res] of Object.entries(r.steps)) {
        if (res.ok && !res.attempts?.length) continue
        console.log(`  ${step}: ${res.detail}`)
        for (const a of res.attempts ?? []) console.log(`    ${a}`)
      }
    }
  }

  if (!KEEP) {
    console.log(`\n[cleanup] deleting drive ${driveName}`)
    await DriveInstance.delete(driveName).catch((e: unknown) => console.error(`could not delete drive: ${formatError(e)}`))
  } else {
    console.log(`\n[KEEP=1] leaving drive ${driveName} and failed-iteration sandboxes alive`)
  }

  process.exit(failures.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
