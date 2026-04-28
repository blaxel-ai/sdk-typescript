import { SandboxInstance, settings } from "@blaxel/core"
import { v4 as uuidv4 } from "uuid"

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason)
})
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err)
  process.exit(1)
})

const PARALLEL = parseInt(process.env.PARALLEL || "5", 10)
const TOTAL = parseInt(process.env.TOTAL || "20", 10)
const DELETING_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 1_000
const IMAGE = "blaxel/base-image:latest"
const LABELS = { env: "manual-test", "created-by": "race-condition-test" }

type SandboxResult = {
  name: string
  success: boolean
  finalStatus: string
  deletingDurationMs: number | null
  error?: string
}

function uniqueName(): string {
  return `race-${uuidv4().replace(/-/g, "").substring(0, 8)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function watchDeletion(name: string): Promise<{ finalStatus: string; deletingDurationMs: number | null }> {
  const start = Date.now()
  let deletingStart: number | null = null

  while (true) {
    try {
      const sbx = await SandboxInstance.get(name)
      const status = sbx.status ?? "UNKNOWN"

      if (status === "TERMINATED") {
        return { finalStatus: "TERMINATED", deletingDurationMs: deletingStart ? Date.now() - deletingStart : 0 }
      }

      if (status === "DELETING") {
        if (!deletingStart) deletingStart = Date.now()
        const elapsed = Date.now() - deletingStart
        if (elapsed > DELETING_TIMEOUT_MS) {
          return { finalStatus: `STUCK_DELETING (${Math.round(elapsed / 1000)}s)`, deletingDurationMs: elapsed }
        }
      }

      if (Date.now() - start > 120_000) {
        return { finalStatus: `TIMEOUT (last: ${status})`, deletingDurationMs: deletingStart ? Date.now() - deletingStart : null }
      }

      await sleep(POLL_INTERVAL_MS)
    } catch {
      return { finalStatus: "GONE", deletingDurationMs: deletingStart ? Date.now() - deletingStart : 0 }
    }
  }
}

async function runOne(index: number): Promise<SandboxResult> {
  const name = uniqueName()
  const tag = `[${index + 1}/${TOTAL} ${name}]`

  try {
    console.log(`${tag} Creating sandbox...`)
    const sbx = await SandboxInstance.create({ name, image: IMAGE, labels: LABELS, memory: 2048 })

    console.log(`${tag} Executing process...`)
    try {
      const baseUrl = sbx.metadata.url ?? `${settings.runUrl}/${settings.workspace}/sandboxes/${name}`
      const res = await globalThis.fetch(`${baseUrl}/process`, {
        method: "POST",
        headers: { ...settings.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo hello" }),
      })
      if (!res.ok) {
        console.error(`${tag} Exec HTTP ${res.status}: ${await res.text()}`)
      } else {
        console.log(`${tag} Process fired.`)
      }
    } catch (execErr: unknown) {
      const msg = execErr instanceof Error ? execErr.message : String(execErr)
      console.error(`${tag} Exec failed (continuing to delete): ${msg}`)
    }

    console.log(`${tag} Deleting sandbox...`)
    await sbx.delete()

    console.log(`${tag} Watching status...`)
    const { finalStatus, deletingDurationMs } = await watchDeletion(name)

    const success = finalStatus === "TERMINATED" || finalStatus === "GONE"
    const icon = success ? "OK" : "FAIL"
    console.log(`${tag} ${icon} -> ${finalStatus} (deleting: ${deletingDurationMs ?? "n/a"}ms)`)

    return { name, success, finalStatus, deletingDurationMs }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${tag} ERROR: ${message}`)
    try { await SandboxInstance.delete(name) } catch {}
    return { name, success: false, finalStatus: "ERROR", deletingDurationMs: null, error: message }
  }
}

async function main() {
  console.log(`\nRace Condition Test`)
  console.log(`  Total sandboxes: ${TOTAL}`)
  console.log(`  Parallel:        ${PARALLEL}`)
  console.log(`  Deleting timeout: ${DELETING_TIMEOUT_MS / 1000}s`)
  console.log()

  const results: SandboxResult[] = []
  const queue = Array.from({ length: TOTAL }, (_, i) => i)

  async function worker() {
    while (queue.length > 0) {
      const index = queue.shift()!
      results.push(await runOne(index))
    }
  }

  const workers = Array.from({ length: Math.min(PARALLEL, TOTAL) }, () => worker())
  await Promise.all(workers)

  console.log(`\n${"=".repeat(60)}`)
  console.log(`RESULTS`)
  console.log(`${"=".repeat(60)}`)

  const passed = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)
  const stuckDeleting = results.filter((r) => r.finalStatus.startsWith("STUCK_DELETING"))

  console.log(`  Passed:         ${passed.length}/${results.length}`)
  console.log(`  Failed:         ${failed.length}/${results.length}`)
  console.log(`  Stuck deleting: ${stuckDeleting.length}/${results.length}`)

  if (failed.length > 0) {
    console.log(`\nFailed sandboxes:`)
    for (const r of failed) {
      console.log(`  - ${r.name}: ${r.finalStatus}${r.error ? ` (${r.error})` : ""}`)
    }
  }

  const deletingTimes = results
    .filter((r) => r.deletingDurationMs !== null)
    .map((r) => r.deletingDurationMs!)

  if (deletingTimes.length > 0) {
    const avg = Math.round(deletingTimes.reduce((a, b) => a + b, 0) / deletingTimes.length)
    const max = Math.max(...deletingTimes)
    const min = Math.min(...deletingTimes)
    console.log(`\nDeleting duration:`)
    console.log(`  Min: ${min}ms | Avg: ${avg}ms | Max: ${max}ms`)
  }

  console.log()

  if (stuckDeleting.length > 0) {
    console.error("PROBLEM DETECTED: Some sandboxes got stuck in DELETING state!")
    process.exit(1)
  }

  if (failed.length > 0) {
    console.error("Some sandboxes failed (see details above).")
    process.exit(1)
  }

  console.log("All sandboxes transitioned cleanly. No race condition detected.")
  process.exit(0)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
