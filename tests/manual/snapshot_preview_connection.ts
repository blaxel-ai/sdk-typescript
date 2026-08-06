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
 *   2. Expose it through a public preview and open the stream.
 *   3. While the stream is being consumed, fire a request every 500ms on fresh
 *      connections (each new connection is what makes node-gw wake the VM).
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
 * Symptom BEFORE the fix (vmm-manager side): every request issued during the
 * snapshot fails, because node-gw asks vmm-manager to wake the VM on each new
 * connection, that call queues behind the lock the snapshot holds, and node-gw
 * gives it 5s before failing the connection.
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

// Chunk cadence of /stream, and how long we keep observing after the snapshot
// returns (long enough to see the stream recover, short enough to stay cheap).
const CHUNK_INTERVAL_MS = 250
const PROBE_INTERVAL_MS = 500
const OBSERVE_AFTER_MS = 5000

const SERVER_JS = `
const http = require("http");
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
    const request = https.request(url, { agent: false, method: "GET" }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk: string) => {
        body += chunk
      })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
      res.on("error", reject)
    })
    request.on("error", reject)
    request.end()
  })
}

/**
 * Hit the preview on a fresh connection every PROBE_INTERVAL_MS until `stop`
 * resolves. New connections are the interesting ones: each one makes node-gw
 * wake the VM, which is what the snapshot used to block.
 */
async function probeUntil(url: string, stop: Promise<void>): Promise<Probe[]> {
  const probes: Probe[] = []
  let running = true
  void stop.then(() => {
    running = false
  })

  while (running) {
    const at = Date.now()
    try {
      const res = await getOnFreshConnection(url)
      const ok = res.status === 200
      probes.push({
        at,
        durationMs: Date.now() - at,
        ok: ok && res.body === READY_BODY,
        detail: ok ? undefined : `status ${res.status}`,
      })
    } catch (e) {
      probes.push({ at, durationMs: Date.now() - at, ok: false, detail: (e as Error).message })
    }
    await sleep(PROBE_INTERVAL_MS)
  }
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
      memory: 2048,
      ports: [{ target: APP_PORT, protocol: "HTTP" }],
    })
    created = true

    await sandbox.fs.write(SERVER_PATH, SERVER_JS)
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

    const during = probes.filter((p) => p.at >= snapshotStart && p.at <= snapshotStart + snapshotMs)
    const failedDuring = during.filter((p) => !p.ok)
    const failedAfter = probes.filter((p) => p.at > snapshotStart + snapshotMs && !p.ok)
    const slowest = probes.reduce((max, p) => Math.max(max, p.durationMs), 0)
    const gapDuringSnapshot =
      stream.maxGapEndedAt >= snapshotStart && stream.maxGapEndedAt <= snapshotStart + snapshotMs + 2000

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
