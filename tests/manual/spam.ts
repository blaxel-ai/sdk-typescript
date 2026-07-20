import { SandboxInstance, authenticate } from "@blaxel/core"

const keepAlive = setInterval(() => {}, 1 << 30)

const TOTAL_PARALLEL = process.argv[2] ? parseInt(process.argv[2], 10) : 0
const TOTAL_SEQ = process.argv[3] ? parseInt(process.argv[3], 10) : 0
const DELETE_AFTER = process.argv[4] === "true" || process.argv[4] === "1"

const createdNames: string[] = []

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function formatMs(ms: number): string {
  return `${ms.toFixed(0)}ms`
}

interface TimedResult {
  name: string
  createMs: number
  execMs: number
  exec2Ms: number
  deleteMs: number
  totalMs: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function timedCreate(runType: "parallel" | "sequential", testName: string): Promise<TimedResult | null> {
  const name = `sandbox-${runType}-${Math.random().toString(36).slice(2, 10)}`
  try {
    const t0 = Date.now()
    const sandbox = await SandboxInstance.create()
    createdNames.push(name)
    const t1 = Date.now()
    // await sandbox.fs.ls("/")
    await sandbox.process.exec({ command: "echo 'hello'" })
    const t2 = Date.now()
    // await sandbox.fs.ls("/")
    // await sandbox.process.exec({ command: "echo 'hello'" })
    const t3 = Date.now()
    let deleteMs = 0
    if (DELETE_AFTER) {
      const td0 = Date.now()
      await SandboxInstance.delete(sandbox.metadata.name!)
      deleteMs = Date.now() - td0
    }
    const tEnd = Date.now()
    return { name, createMs: t1 - t0, execMs: t2 - t1, exec2Ms: t3 - t2, deleteMs, totalMs: tEnd - t0 }
  } catch (err) {
    createdNames.push(name)
    console.error(`  [ERROR] ${name}:`, err instanceof Error ? err.message : JSON.stringify(err, null, 2))
    return null
  }
}

async function cleanup(testName: string) {
  try {
    const sandboxes = await SandboxInstance.list()
    console.log(`\nFound ${sandboxes.length} total sandboxes`)
    for (const s of sandboxes.slice(0, 5)) {
      console.log(`  ${s.metadata.name} labels:`, JSON.stringify(s.metadata.labels))
    }
    if (sandboxes.length > 5) console.log(`  ... and ${sandboxes.length - 5} more`)
    const toDelete = sandboxes.filter((s) => s.metadata.labels?.testName === testName)
    if (toDelete.length === 0) {
      console.log(`No sandboxes found with testName="${testName}", skipping cleanup`)
      return
    }
    console.log(`\nCleaning up ${toDelete.length} sandboxes...`)
    const results = await Promise.allSettled(
      toDelete.map((s) => SandboxInstance.delete(s.metadata.name!))
    )
    const failed = results.filter((r) => r.status === "rejected").length
    if (failed > 0) console.error(`  ${failed} sandbox(es) failed to delete`)
    console.log("Cleanup done.")
  } catch (err) {
    console.error("Cleanup failed:", err instanceof Error ? err.message : err)
  }
}

interface Stats {
  mean: number
  p50: number
  p75: number
  p90: number
  p99: number
  min: number
  max: number
}

function computeStats(durations: number[]): Stats {
  const sorted = [...durations].sort((a, b) => a - b)
  return {
    mean: durations.reduce((a, b) => a + b, 0) / durations.length,
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  }
}

interface PhaseStats {
  create: Stats
  exec: Stats
  exec2: Stats
  delete: Stats
  total: Stats
}

function printResults(label: string, results: TimedResult[]): PhaseStats {
  const createDurations = results.map((r) => r.createMs)
  const execDurations = results.map((r) => r.execMs)
  const exec2Durations = results.map((r) => r.exec2Ms)
  const deleteDurations = results.map((r) => r.deleteMs)
  const totalDurations = results.map((r) => r.totalMs)

  const phases = {
    create: computeStats(createDurations),
    exec: computeStats(execDurations),
    exec2: computeStats(exec2Durations),
    delete: computeStats(deleteDurations),
    total: computeStats(totalDurations),
  }

  console.log(`\n========== ${label} (${results.length} sandboxes) ==========`)
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    console.log(`  ${r.name}: create=${formatMs(r.createMs)}  exec=${formatMs(r.execMs)}  exec2=${formatMs(r.exec2Ms)}  delete=${formatMs(r.deleteMs)}  total=${formatMs(r.totalMs)}`)
  }

  for (const [phase, stats] of Object.entries(phases) as [string, Stats][]) {
    console.log(`  ---- ${phase.toUpperCase()} ----`)
    console.log(`  Mean: ${formatMs(stats.mean)}`)
    console.log(`  P50:  ${formatMs(stats.p50)}`)
    console.log(`  P75:  ${formatMs(stats.p75)}`)
    console.log(`  P90:  ${formatMs(stats.p90)}`)
    console.log(`  P99:  ${formatMs(stats.p99)}`)
    console.log(`  Min:  ${formatMs(stats.min)}`)
    console.log(`  Max:  ${formatMs(stats.max)}`)
  }

  return phases
}

async function main() {
  authenticate()
  console.log(`Benchmarking SandboxInstance.create() + exec + exec2${DELETE_AFTER ? " + delete" : ""}`)
  console.log(`Parallel: ${TOTAL_PARALLEL}, Sequential: ${TOTAL_SEQ}, Delete after: ${DELETE_AFTER}\n`)

  let parallelStats: PhaseStats | null = null
  let sequentialStats: PhaseStats | null = null
  let parallelWall = 0
  let sequentialWall = 0
  let testName = "test-"+Math.random().toString(36).slice(2, 10)
  console.log(`Test name: ${testName}\n`)

  try {
    if (TOTAL_PARALLEL > 0) {
      console.log(`>>> Running ${TOTAL_PARALLEL} sandboxes in parallel...`)
      const parallelStart = Date.now()
      const parallelRaw = await Promise.all(
        Array.from({ length: TOTAL_PARALLEL }, () => timedCreate("parallel", testName))
      )
      parallelWall = Date.now() - parallelStart
      const parallelResults = parallelRaw.filter((r): r is TimedResult => r !== null)
      const parallelErrors = parallelRaw.length - parallelResults.length
      console.log(`Wall clock: ${formatMs(parallelWall)} (${parallelResults.length} ok, ${parallelErrors} failed)`)
      if (parallelResults.length > 0) {
        parallelStats = printResults("Parallel", parallelResults)
      }
    }

    if (TOTAL_SEQ > 0) {
      console.log(`\n>>> Running ${TOTAL_SEQ} sandboxes sequentially...`)
      const sequentialResults: TimedResult[] = []
      let sequentialErrors = 0
      const sequentialStart = Date.now()
      for (let i = 0; i < TOTAL_SEQ; i++) {
        const result = await timedCreate("sequential", testName)
        if (result) {
          sequentialResults.push(result)
          console.log(`  Run ${i + 1}/${TOTAL_SEQ} ${result.name}: create=${formatMs(result.createMs)}  exec=${formatMs(result.execMs)}  exec2=${formatMs(result.exec2Ms)}  delete=${formatMs(result.deleteMs)}  total=${formatMs(result.totalMs)}`)
        } else {
          sequentialErrors++
        }
      }
      sequentialWall = Date.now() - sequentialStart
      console.log(`Wall clock: ${formatMs(sequentialWall)} (${sequentialResults.length} ok, ${sequentialErrors} failed)`)
      if (sequentialResults.length > 0) {
        sequentialStats = printResults("Sequential", sequentialResults)
      }
    }

    if (parallelStats && sequentialStats) {
      console.log(`\n========== Comparison (Parallel vs Sequential) ==========`)
      const phases: (keyof PhaseStats)[] = ["create", "exec", "exec2", "delete", "total"]
      const keys: (keyof Stats)[] = ["mean", "p50", "p75", "p90", "p99", "min", "max"]
      for (const phase of phases) {
        console.log(`  ---- ${phase.toUpperCase()} ----`)
        for (const key of keys) {
          const diff = parallelStats[phase][key] - sequentialStats[phase][key]
          const sign = diff > 0 ? "+" : ""
          console.log(`  ${key.toUpperCase().padEnd(5)}: ${formatMs(parallelStats[phase][key])} vs ${formatMs(sequentialStats[phase][key])}  (${sign}${formatMs(diff)})`)
        }
      }
      console.log(`  WALL:  ${formatMs(parallelWall)} vs ${formatMs(sequentialWall)}  (${parallelWall < sequentialWall ? "parallel faster" : "sequential faster"})`)
    }
  } finally {
    if (!DELETE_AFTER) {
      await cleanup(testName)
    } else {
      console.log("\nSkipping cleanup (sandboxes already deleted inline).")
    }
  }
}

main().then(() => {
  console.log("\nScript completed successfully.")
}).catch((err) => {
  console.error("Fatal:", err)
  process.exitCode = 1
}).finally(() => {
  clearInterval(keepAlive)
})
