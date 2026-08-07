/**
 * Manual reproducer: forking a sandbox must not break the connections the
 * SOURCE sandbox's preview is already serving.
 *
 * Reported by a customer, with their own reproducer: a WebSocket open through a
 * public preview, `SandboxInstance.fork()` on that sandbox, and the WebSocket
 * dies with code 1006 about two seconds later. Nothing restarted the app.
 *
 * Why forking can reach the source's connections at all: a fork resumes from a
 * memory snapshot of the source, so the forked guest comes up holding the
 * SOURCE sandbox's IPv6 address and every TCP socket the source had open,
 * including the customer's WebSocket. Before it is told its own address it
 * retransmits on those sockets, and when the address is swapped the guest
 * resets them — all of it sourced from the source sandbox's address, so
 * node-gw sees it as the source's live flow and tears that flow down. The
 * execution-plane fix pins each VM's source address in the datapath, so a fork
 * simply cannot speak as its parent.
 *
 * This is a DIFFERENT failure from snapshot_preview_connection.ts: there the
 * snapshot's pause blocked node-gw from waking the VM, so NEW connections
 * failed while the open one only stalled. Here the connection that was already
 * open is the one that dies, and the source sandbox is never paused for long.
 *
 * What this script does:
 *   1. Create a source sandbox running a dependency-free RFC6455 WebSocket
 *      server (a raw `upgrade` handler, no ws package) that sends a tick every
 *      second, and expose it through a public preview.
 *   2. Open a WebSocket through the preview and check ticks are flowing.
 *   3. Fork the sandbox while that WebSocket is open, also probing fresh
 *      connections to the SOURCE so a regression of the snapshot bug shows up
 *      here too (a fork snapshots the source).
 *   4. Keep watching for 15s and report whether the WebSocket survived, and if
 *      not, how long after the fork it died.
 *
 * Expected AFTER the fix: the WebSocket keeps ticking across the fork (a short
 * stall while the source is paused for its snapshot is fine), and every fresh
 * request to the source is served.
 *
 * Symptom BEFORE the fix: the WebSocket closes a couple of seconds after the
 * fork is issued, with no close frame (1006) — the customer's report.
 *
 * This lives under tests/manual because it creates two real sandboxes and its
 * whole point is the wall-clock fate of a live connection.
 *
 * Auth: whatever `bl login` left in ~/.blaxel, or BL_WORKSPACE + BL_API_KEY.
 *
 * Run:
 *   cd @blaxel/core && npm run build && cd ../..
 *   npx tsx tests/manual/fork_preview_connection.ts
 */

import crypto from "node:crypto"
import https from "node:https"
import type { Duplex } from "node:stream"

import { SandboxInstance } from "@blaxel/core"

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const BASE_IMAGE = "blaxel/base-image:latest"
const APP_PORT = 3000
const SERVER_PATH = "/app/ws-server.js"
const READY_BODY = "alive"
const TICK_INTERVAL_MS = 1000
// The customer saw the close ~2-3s after the fork returned; watch well past it.
const OBSERVE_AFTER_MS = 15000
const PROBE_INTERVAL_MS = 500
const PROBE_TIMEOUT_MS = 30000

const SERVER_JS = `
const http = require("http");
const crypto = require("crypto");

// RFC6455 handshake by hand: the reproducer must not depend on anything being
// installed in the sandbox.
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("${READY_BODY}");
});

server.on("upgrade", (req, socket) => {
  const accept = crypto
    .createHash("sha1")
    .update(req.headers["sec-websocket-key"] + GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\\r\\n" +
      "Upgrade: websocket\\r\\nConnection: Upgrade\\r\\n" +
      "Sec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n",
  );
  // Unmasked text frame, payload always < 126 bytes.
  const frame = (s) => {
    const b = Buffer.from(s);
    return Buffer.concat([Buffer.from([0x81, b.length]), b]);
  };
  let n = 0;
  const timer = setInterval(() => {
    if (socket.writable) socket.write(frame("tick " + ++n));
  }, ${TICK_INTERVAL_MS});
  const stop = () => clearInterval(timer);
  socket.on("close", stop);
  socket.on("error", stop);
});

server.listen(${APP_PORT}, "0.0.0.0", () => console.log("listening on ${APP_PORT}"));
`

type SocketObservation = {
  ticks: number
  /** Longest silence between two ticks — a stall, which a pause legitimately causes. */
  maxGapMs: number
  /** When the socket died, or undefined if it was still open at the end. */
  closedAt?: number
  closeReason?: string
}

/**
 * Open a WebSocket through the preview and keep reading ticks until `stop`.
 * Hand-rolled on top of https' `upgrade` event rather than the global
 * WebSocket, which is not available on every Node version this repo supports.
 * Only the tick cadence and the socket's fate matter, so frames are counted,
 * not parsed.
 */
function openWebSocket(
  url: string,
  stop: Promise<void>,
): { opened: Promise<void>; observation: SocketObservation; done: Promise<SocketObservation> } {
  const observation: SocketObservation = { ticks: 0, maxGapMs: 0 }
  let resolveOpened!: () => void
  let rejectOpened!: (e: Error) => void
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpened = resolve
    rejectOpened = reject
  })

  const done = new Promise<SocketObservation>((resolve) => {
    const request = https.request(url, {
      agent: false,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
      },
    })

    let socket: Duplex | undefined
    let stopped = false
    void stop.then(() => {
      stopped = true
      socket?.destroy()
      resolve(observation)
    })

    const die = (reason: string) => {
      if (stopped || observation.closedAt) return
      observation.closedAt = Date.now()
      observation.closeReason = reason
      resolve(observation)
    }

    request.on("upgrade", (_res, sock) => {
      socket = sock
      resolveOpened()
      let last = Date.now()
      sock.on("data", () => {
        const now = Date.now()
        observation.maxGapMs = Math.max(observation.maxGapMs, now - last)
        last = now
        observation.ticks++
      })
      // No close frame, no FIN from the app: the connection was cut underneath
      // it. This is what the customer sees as code 1006.
      sock.on("close", () => die("socket closed without a close frame (1006)"))
      sock.on("error", (e: Error) => die(e.message))
    })
    request.on("response", (res) => {
      rejectOpened(new Error(`upgrade refused with status ${res.statusCode}`))
      resolve(observation)
    })
    request.on("error", (e: Error) => {
      rejectOpened(e)
      die(e.message)
    })
    request.end()
  })

  return { opened, observation, done }
}

type Probe = { at: number; durationMs: number; ok: boolean; detail?: string }

/** One GET on a brand-new TCP connection (`agent: false`), so node-gw has to wake the VM. */
function getOnFreshConnection(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { agent: false, method: "GET", timeout: PROBE_TIMEOUT_MS }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk: string) => {
        body += chunk
      })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
      res.on("error", reject)
    })
    request.on("timeout", () => request.destroy(new Error(`no response within ${PROBE_TIMEOUT_MS}ms`)))
    request.on("error", reject)
    request.end()
  })
}

/** Probe the SOURCE's preview on a fresh connection every beat until `stop`, never awaiting a probe. */
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
          const ok = res.status === 200 && res.body === READY_BODY
          probes.push({ at, durationMs: Date.now() - at, ok, detail: ok ? undefined : `status ${res.status}` })
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
  const name = uniqueName("fork-conn")
  const forkName = `${name}-fork`
  let created = false
  let forked = false

  try {
    console.log(`Creating sandbox ${name}...`)
    const sandbox = await SandboxInstance.create({
      name,
      image: BASE_IMAGE,
      memory: 2048,
      ports: [{ target: APP_PORT, protocol: "HTTP" }],
    })
    created = true

    // `create` resolves before the sandbox API is routable, so the first call
    // into the guest can still get a 404 from the edge.
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
      metadata: { name: "fork-conn-preview" },
      spec: { port: APP_PORT, public: true },
    })
    const url = preview.spec?.url
    if (!url) throw new Error("preview has no URL")
    console.log(`  preview: ${url}`)

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

    let stopWatchers!: () => void
    const stop = new Promise<void>((resolve) => {
      stopWatchers = resolve
    })

    const ws = openWebSocket(url, stop)
    await ws.opened
    const probesPromise = probeUntil(url, stop)

    // Let ticks flow before forking, so a dead socket can only be the fork's doing.
    await sleep(5000)
    if (ws.observation.closedAt) throw new Error(`the WebSocket died before the fork: ${ws.observation.closeReason}`)
    console.log(`  websocket open, ${ws.observation.ticks} ticks received`)

    console.log(`Forking ${name} into ${forkName}...`)
    const forkStart = Date.now()
    await sandbox.fork(forkName, { targetType: "sandbox" })
    const forkMs = Date.now() - forkStart
    forked = true
    console.log(`  fork returned after ${forkMs}ms`)

    await sleep(OBSERVE_AFTER_MS)
    stopWatchers()
    const [socket, probes] = await Promise.all([ws.done, probesPromise])

    const failed = probes.filter((p) => !p.ok)

    console.log("\n--- results ---")
    console.log(`fork duration:                ${forkMs}ms`)
    console.log(`websocket ticks received:     ${socket.ticks}`)
    console.log(`longest tick gap:             ${socket.maxGapMs}ms (tick interval is ${TICK_INTERVAL_MS}ms)`)
    console.log(
      `websocket after the fork:     ` +
        (socket.closedAt
          ? `DIED ${socket.closedAt - forkStart}ms after the fork was issued (${socket.closeReason})`
          : "still open"),
    )
    console.log(`requests to the source:       ${probes.length}, failed: ${failed.length}`)
    for (const p of failed) {
      console.log(`  failed at ${p.at - forkStart}ms relative to the fork, after ${p.durationMs}ms: ${p.detail}`)
    }

    const failures: string[] = []
    if (socket.closedAt) {
      failures.push(
        `the WebSocket open across the fork died ${socket.closedAt - forkStart}ms after it was issued:` +
          ` ${socket.closeReason}`,
      )
    }
    if (socket.ticks === 0) failures.push("the WebSocket never received a tick")
    if (failed.length > 0) failures.push(`${failed.length}/${probes.length} requests to the source sandbox failed`)
    // The fork's own guest is reconfigured, but the source keeps ticking; a stall
    // far beyond the source's snapshot pause means its flow was disturbed too.
    if (!socket.closedAt && socket.maxGapMs > forkMs + 5 * TICK_INTERVAL_MS) {
      failures.push(`the source's WebSocket stalled for ${socket.maxGapMs}ms, well past the ${forkMs}ms fork`)
    }

    if (failures.length > 0) {
      console.error("\n❌ Forking disturbed the source sandbox's live connections:")
      for (const f of failures) console.error(`  - ${f}`)
      process.exitCode = 1
      return
    }

    console.log("\n✅ The fork left the source sandbox's open WebSocket and its preview alone.")
  } finally {
    console.log("\n🧹 Cleaning up...")
    for (const [label, target] of [
      ["fork", forked ? forkName : undefined],
      ["sandbox", created ? name : undefined],
    ] as const) {
      if (!target) continue
      try {
        await SandboxInstance.delete(target)
        console.log(`  deleted ${label} ${target}`)
      } catch (e) {
        console.warn(`  failed to delete ${label} ${target}: ${(e as Error).message}`)
      }
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
