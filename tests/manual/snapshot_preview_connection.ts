/**
 * Manual reproducer: taking a snapshot of a running sandbox must not break the
 * connections its preview is already serving.
 *
 * Reported by a customer: a sandbox with a preview, a snapshot taken while it
 * was in use, and the active connection to the ORIGINAL sandbox died.
 *
 * A snapshot has to pause the guest (firecracker writes the memory file with the
 * vCPUs stopped), so the app legitimately goes quiet for the length of the
 * snapshot. What must NOT happen is a connection dying: pausing vCPUs leaves the
 * datapath and every established TCP flow intact, so an in-flight stream should
 * only stall and then continue, and requests issued during the snapshot should
 * be served (late is fine) rather than failed.
 *
 * What this script does:
 *   1. Create a sandbox running a tiny HTTP server on port 3000 with
 *      - GET /            -> "ok"
 *      - GET /stream      -> one chunk every 250ms, forever (the "active
 *                            connection" the customer had open)
 *      The server also dirties most of the guest's RAM, because the pause lasts
 *      as long as writing out that memory: an idle sandbox snapshots in ~400ms,
 *      which is too fast to show the bug.
 *   2. Expose it through a public preview and open the stream.
 *   3. While the stream is being consumed, open a fresh connection every 250ms
 *      without waiting for the previous one (each new connection is what makes
 *      node-gw wake the VM, and the bug makes them pile up).
 *   4. Take a snapshot of the sandbox (this is the compute-admin snapshot).
 *   5. Keep both going for a few seconds after the snapshot returns, then report:
 *      - did the open stream survive the snapshot (or did it error/EOF)?
 *      - the longest gap between two chunks vs the snapshot duration
 *      - how many of the requests issued during the snapshot failed
 *
 * Expected AFTER the fix: stream alive, 0 failed requests. The longest stream
 * gap and the slowest request line up with the snapshot's pause — that stall is
 * the snapshot, not a broken connection.
 *
 * Symptom BEFORE the fix (vmm-manager side), reproduced on us-was-1 with an ~11s
 * pause: the already-open stream survived, but every connection opened during
 * the pause got a 502 after ~5.28s. node-gw asks vmm-manager to wake the VM on
 * each new connection, that call queues behind the lock the snapshot holds, and
 * node-gw gives it 5s. So what the customer loses is not the socket they had
 * open, it is everything the page opens next.
 *
 *   requests during snapshot:     44, failed: 20
 *     failed at +778ms after 5287ms: status 502
 *
 * This lives under tests/manual because it creates a real sandbox and takes a
 * real snapshot of it, and its whole point is the wall-clock behaviour of a live
 * connection.
 *
 * Auth: whatever `bl login` left in ~/.blaxel, or BL_WORKSPACE + BL_API_KEY.
 *
 * Run:
 *   cd @blaxel/core && npm run build && cd ../..
 *   npx tsx tests/manual/snapshot_preview_connection.ts
 */

import https from "node:https"

import { SandboxInstance } from "@blaxel/core"

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const BASE_IMAGE = "blaxel/base-image:latest"
const APP_PORT = 3000
const SERVER_PATH = "/app/server.js"
const READY_BODY = "ok"

// The pause lasts as long as firecracker needs to write out the dirty memory,
// and the break only appears once it outlasts node-gw's 5s wake deadline. Pause
// measured on us-was-1 against the size of the guest's dirtied RAM:
//   idle ~0.4s · 3GB ~1.3s · 15GB ~5.4s (right at the edge) · 31GB ~11s (breaks)
// So the default is deliberately big; override to bracket the threshold.
const SANDBOX_MEMORY_MB = Number(process.env.MEMORY_MB ?? 32768)
// Dirtied (not just allocated) inside the guest before the snapshot.
const BALLAST_MB = Number(process.env.BALLAST_MB ?? SANDBOX_MEMORY_MB - 1024)

// Chunk cadence of /stream, and how long we keep observing after the snapshot
// returns (long enough to see the stream recover, short enough to stay cheap).
const CHUNK_INTERVAL_MS = 250
// Probes are fired on this beat and NOT awaited, so a long pause accumulates
// many in-flight wake-ups instead of one straggler per snapshot.
const PROBE_INTERVAL_MS = 250
const OBSERVE_AFTER_MS = 5000
// Node puts no deadline on a socket, and a probe the edge accepts but never
// answers is precisely what this script provokes — without this the run could
// wait on it forever instead of reporting it.
const PROBE_TIMEOUT_MS = 30000

const SERVER_JS = `
const http = require("http");

// Dirty pages the snapshot will have to write out. Filled (not just allocated)
// so the pages are really resident, and kept referenced so they survive GC.
const ballast = [];
for (let i = 0; i < ${Math.round(BALLAST_MB / 64)}; i++) {
  ballast.push(Buffer.alloc(64 * 1024 * 1024, i % 256));
}
console.log("ballast resident: ${BALLAST_MB}MB");

http
  .createServer((req, res) => {
    if (req.url === "/stream") {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-cache",
        // No compression/buffering: every chunk must reach the client as it is
        // written, otherwise the gap we measure is the proxy's, not the VM's.
        "X-Accel-Buffering": "no",
      });
      let n = 0;
      const timer = setInterval(() => {
        res.write("chunk " + n++ + "\\n");
      }, ${CHUNK_INTERVAL_MS});
      req.on("close", () => clearInterval(timer));
      return;
    }
    res.writeHead(200);
    res.end("${READY_BODY}");
  })
  .listen(${APP_PORT}, () => console.log("listening on ${APP_PORT}"));
`

type StreamObservation = {
  chunks: number
  /** Longest silence between two consecutive chunks. */
  maxGapMs: number
  /** When that longest silence ended, so it can be lined up with the snapshot. */
  maxGapEndedAt: number
  /** Set when the stream died instead of just stalling — the reported bug. */
  brokenWith?: string
}

/**
 * Consume /stream until `stop` resolves, recording the gaps between chunks. A
 * gap is a stall (fine, the guest is paused); an error or an early end is the
 * connection breaking (the bug).
 */
async function observeStream(url: string, stop: Promise<void>): Promise<StreamObservation> {
  const controller = new AbortController()
  void stop.then(() => controller.abort())

  const observation: StreamObservation = { chunks: 0, maxGapMs: 0, maxGapEndedAt: 0 }
  try {
    const response = await fetch(`${url}/stream`, { signal: controller.signal })
    if (!response.ok || !response.body) {
      observation.brokenWith = `stream request returned status ${response.status}`
      return observation
    }
    const reader = response.body.getReader()
    let last = Date.now()
    for (;;) {
      const { done } = await reader.read()
      if (done) {
        // The server never ends /stream, so an EOF means something between us
        // and the app closed the connection.
        if (!controller.signal.aborted) observation.brokenWith = "stream ended early (EOF)"
        return observation
      }
      const now = Date.now()
      const gap = now - last
      if (gap > observation.maxGapMs) {
        observation.maxGapMs = gap
        observation.maxGapEndedAt = now
      }
      last = now
      observation.chunks++
    }
  } catch (e) {
    if (!controller.signal.aborted) observation.brokenWith = (e as Error).message
    return observation
  }
}

type Probe = { at: number; durationMs: number; ok: boolean; detail?: string }

/**
 * One GET on a brand-new TCP connection. This does NOT go through `fetch`:
 * undici pools connections and drops `connection: close` (a forbidden header),
 * so a fetch-based probe would ride the socket the previous probe opened and
 * never make node-gw wake the VM — which is the whole point of these probes.
 * `agent: false` gives every probe its own socket, closed right after.
 */
function getOnFreshConnection(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      { agent: false, method: "GET", timeout: PROBE_TIMEOUT_MS },
      (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => {
          body += chunk
        })
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
        res.on("error", reject)
      },
    )
    request.on("timeout", () => {
      request.destroy(new Error(`no response within ${PROBE_TIMEOUT_MS}ms`))
    })
    request.on("error", reject)
    request.end()
  })
}

/**
 * Open a fresh connection to the preview every PROBE_INTERVAL_MS until `stop`
 * resolves. New connections are the interesting ones: each one makes node-gw
 * wake the VM, which is what the snapshot blocks.
 *
 * Probes are started on the beat and NOT awaited: a probe that hangs for the
 * whole pause must not stop the next one from being attempted, since what the
 * bug produces is a pile of connections all waiting on the same wake-up.
 */
async function probeUntil(url: string, stop: Promise<void>): Promise<Probe[]> {
  const probes: Probe[] = []
  const inFlight: Promise<void>[] = []
  let running = true
  void stop.then(() => {
    running = false
  })

  while (running) {
    const at = Date.now()
    inFlight.push(
      getOnFreshConnection(url).then(
        (res) => {
          const ok = res.status === 200
          probes.push({
            at,
            durationMs: Date.now() - at,
            ok: ok && res.body === READY_BODY,
            detail: ok ? undefined : `status ${res.status}`,
          })
        },
        (e: Error) => {
          probes.push({ at, durationMs: Date.now() - at, ok: false, detail: e.message })
        },
      ),
    )
    await sleep(PROBE_INTERVAL_MS)
  }
  await Promise.all(inFlight)
  return probes
}

async function main() {
  const name = uniqueName("snap-conn")
  let created = false
  let snapshotId: string | undefined

  try {
    console.log(`Creating sandbox ${name}...`)
    const sandbox = await SandboxInstance.create({
      name,
      image: BASE_IMAGE,
      memory: SANDBOX_MEMORY_MB,
      ports: [{ target: APP_PORT, protocol: "HTTP" }],
    })
    created = true

    // `create` resolves before the sandbox API is routable, so the first call
    // into the guest can still get a 404 from the edge ("no service on this
    // URL"). Retry until it lands.
    for (let i = 0; ; i++) {
      try {
        await sandbox.fs.write(SERVER_PATH, SERVER_JS)
        break
      } catch (e) {
        if (i === 30) throw e
        await sleep(2000)
      }
    }
    await sandbox.process.exec({ command: `node ${SERVER_PATH}`, waitForCompletion: false })

    const preview = await sandbox.previews.create({
      metadata: { name: "snap-conn-preview" },
      spec: { port: APP_PORT, public: true },
    })
    const url = preview.spec?.url
    if (!url) throw new Error("preview has no URL")
    console.log(`  preview: ${url}`)

    // Wait for the app to answer through the preview before measuring anything.
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(url)
        if (res.ok && (await res.text()) === READY_BODY) break
      } catch {
        /* not up yet */
      }
      if (i === 30) throw new Error("preview never served the app")
      await sleep(2000)
    }
    console.log("  app is serving through the preview ✔")

    // Everything below runs concurrently: the open stream, the fresh-connection
    // probes, and the snapshot in the middle of them.
    let stopWatchers!: () => void
    const stop = new Promise<void>((resolve) => {
      stopWatchers = resolve
    })
    const streamPromise = observeStream(url, stop)
    const probesPromise = probeUntil(url, stop)

    // Let both settle into a rhythm so the snapshot lands mid-stream.
    await sleep(3000)

    console.log("Taking a snapshot of the running sandbox...")
    const snapshotStart = Date.now()
    const snapshot = await sandbox.snapshot(`while-connected-${Date.now()}`)
    const snapshotMs = Date.now() - snapshotStart
    snapshotId = snapshot.id
    console.log(`  snapshot ${snapshot.id} created in ${snapshotMs}ms`)

    await sleep(OBSERVE_AFTER_MS)
    stopWatchers()
    const [stream, probes] = await Promise.all([streamPromise, probesPromise])

    const snapshotEnd = snapshotStart + snapshotMs
    // A probe counts as "during" when it was in flight at any point of the
    // pause, not just when it started inside it: a warmup probe still waiting
    // when the snapshot begins is exactly one of the connections that break.
    const during = probes.filter((p) => p.at <= snapshotEnd && p.at + p.durationMs >= snapshotStart)
    const failedDuring = during.filter((p) => !p.ok)
    const failedAfter = probes.filter((p) => p.at > snapshotEnd && !p.ok)
    const slowest = probes.reduce((max, p) => Math.max(max, p.durationMs), 0)
    const gapDuringSnapshot =
      stream.maxGapEndedAt >= snapshotStart && stream.maxGapEndedAt <= snapshotEnd + 2000

    console.log("\n--- results ---")
    console.log(`snapshot duration:            ${snapshotMs}ms`)
    console.log(`stream chunks received:       ${stream.chunks}`)
    console.log(
      `longest stream stall:         ${stream.maxGapMs}ms` +
        ` (${gapDuringSnapshot ? "during the snapshot" : "NOT during the snapshot"})`,
    )
    console.log(`requests during snapshot:     ${during.length}, failed: ${failedDuring.length}`)
    console.log(`requests failed after:        ${failedAfter.length}`)
    console.log(`slowest request:              ${slowest}ms`)
    for (const p of [...failedDuring, ...failedAfter]) {
      console.log(`  failed at +${p.at - snapshotStart}ms after ${p.durationMs}ms: ${p.detail}`)
    }

    const failures: string[] = []
    if (stream.brokenWith) {
      failures.push(`the connection open across the snapshot broke: ${stream.brokenWith}`)
    }
    if (stream.chunks === 0) failures.push("the stream never delivered a chunk")
    if (failedDuring.length > 0) {
      failures.push(`${failedDuring.length}/${during.length} requests issued during the snapshot failed`)
    }
    if (failedAfter.length > 0) {
      failures.push(`${failedAfter.length} requests failed after the snapshot completed`)
    }

    if (failures.length > 0) {
      console.error("\n❌ Snapshot broke the sandbox's connections:")
      for (const f of failures) console.error(`  - ${f}`)
      process.exitCode = 1
      return
    }

    console.log(
      "\n✅ The snapshot only stalled the sandbox: the open connection survived and" +
        " every request was served.",
    )
  } finally {
    console.log("\n🧹 Cleaning up...")
    if (created) {
      if (snapshotId) {
        try {
          const sandbox = await SandboxInstance.get(name)
          await sandbox.deleteSnapshot(snapshotId)
          console.log(`  deleted snapshot ${snapshotId}`)
        } catch (e) {
          console.warn(`  failed to delete snapshot ${snapshotId}: ${(e as Error).message}`)
        }
      }
      try {
        await SandboxInstance.delete(name)
        console.log(`  deleted sandbox ${name}`)
      } catch (e) {
        console.warn(`  failed to delete sandbox ${name}: ${(e as Error).message}`)
      }
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
