// Regression: ENG-2678
//
// ENG-2678: the per-domain HTTP/2 concurrency gate counted requests-AWAITING-
// HEADERS, not OPEN streams. The slot from `acquireH2Slot(domain)` was released
// in the pool-backed wrappers' `finally{rel()}` as soon as the inner promise
// resolved — and that promise resolves on the `"response"` event (headers), with
// a lazy body `ReadableStream` still open. So a long-lived streaming response
// (process.streamLogs / execWithStreaming / port proxy) freed its slot at headers
// while its stream stayed open for minutes, and the gate over-admitted streams
// onto the one shared session: the exact OPEN-stream overload the cap was meant
// to prevent.
//
// The fix (h2fetch.ts) ties the slot to the OPEN-STREAM lifetime — the SAME
// lifetime as the h2ref active-request ref — releasing it from
// `cleanupActiveRequest()` on every terminal path (pre-response reject, abort,
// stream end/error, ReadableStream cancel). Paths that never open a stream on the
// shared session (fetch fallbacks) release the slot immediately so they do not
// count against the open-stream budget. The H2_SLOT_TIMEOUT_MS safety timer is
// kept ONLY as a last-resort leak guard and NEVER aborts/cancels the request.
//
// These tests wire a REAL `ClientHttp2Session` from the fault harness into a REAL
// `H2Pool` via the documented `_establish` hook and drive `createPoolBackedH2Fetch`,
// asserting against the harness's server-side open-stream accounting.
//
// Determinism: stream A is held OPEN with NO timer (`holdStreamOpenUntilRelease`)
// and ended on demand (`releaseHeldStreams`). To give request B a genuine, fully
// event-driven opportunity to (wrongly) open a stream we spin the event loop a
// bounded number of macrotask turns rather than sleeping a fixed wall-clock span
// — pre-fix B opens within ~1 turn, post-fix B is slot-blocked and never opens.
// The authoritative assertion is the server-side PEAK concurrent-stream count,
// which can only exceed the cap if the gate under-counts open streams.
import type http2 from "http2";
import { afterEach, describe, expect, it } from "vitest";
import { createPoolBackedH2Fetch } from "../../../@blaxel/core/src/common/h2fetch.js";
import { H2Pool } from "../../../@blaxel/core/src/common/h2pool.js";
import { settings } from "../../../@blaxel/core/src/common/settings.js";
import {
  startH2FaultServer,
  type H2FaultServer,
} from "../fault-injection/h2-fault-server.js";

const DOMAIN = "edge.open-stream.example.com";
// Macrotask-turn budget for "B had every chance to open a stream". Pre-fix B
// arrives within ~1 turn over loopback; the budget is generous so a slow CI
// scheduler cannot make a green (post-fix) run flaky, yet it never sleeps.
const OPEN_CHANCE_TURNS = 50;

type EstablishHook = {
  _establish: (domain: string) => Promise<http2.ClientHttp2Session>;
};

let server: H2FaultServer | undefined;
let pool: H2Pool | undefined;

afterEach(async () => {
  delete settings.config.maxConcurrentH2Requests;
  if (pool) pool.closeAll();
  pool = undefined;
  if (server) await server.close();
  server = undefined;
});

/** Real H2Pool whose establish() hands out a fresh real harness session. */
function makePool(): H2Pool {
  const p = new H2Pool();
  (p as unknown as EstablishHook)._establish = () =>
    Promise.resolve(server!.connectClient());
  return p;
}

/** Yield one macrotask turn so pending I/O callbacks can run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Spin the event loop up to `turns` macrotask turns, stopping as soon as
 * `done()` holds. Returns whether `done()` became true. Fully event-driven: no
 * fixed wall-clock delay gates control flow.
 */
async function spinUntil(done: () => boolean, turns: number): Promise<boolean> {
  for (let i = 0; i < turns; i++) {
    if (done()) return true;
    await tick();
  }
  return done();
}

/** Read a ReadableStream to completion, returning the decoded text. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

const arrived = (path: string): boolean =>
  server!.requests.some((r) => r.path === path);

describe("ENG-2678: the H2 gate bounds OPEN streams, not requests-awaiting-headers", () => {
  it("cap=1: while A's stream is held OPEN, B does not open a stream; B proceeds only after A's stream ends", async () => {
    server = await startH2FaultServer({
      command: { holdStreamOpenUntilRelease: true },
    });
    settings.config.maxConcurrentH2Requests = 1;
    pool = makePool();
    const h2fetch = createPoolBackedH2Fetch(pool, DOMAIN);

    // Request A: server responds with headers + a first chunk, then HOLDS the
    // stream open. Await A's Response (headers) but do NOT drain its body, so
    // A's stream stays OPEN on the server.
    const aRes = await h2fetch(new Request(`${server.url}/stream-a`));
    expect(aRes.status).toBe(200);
    expect(await spinUntil(() => arrived("/stream-a"), OPEN_CHANCE_TURNS)).toBe(
      true,
    );
    expect(server.concurrentStreams()).toBe(1);

    // Request B: a second pool-backed request to the SAME domain, started while
    // A's stream is still open. Under an OPEN-stream cap it must QUEUE behind
    // A's slot and NOT open a stream on the shared session.
    let bSettled = false;
    const bResP = h2fetch(new Request(`${server.url}/stream-b`)).then((r) => {
      bSettled = true;
      return r;
    });

    // Give B every chance to (wrongly) open a stream: spin the event loop until
    // B arrives OR the turn budget is exhausted. Pre-fix A's slot freed at
    // headers and B opens here within ~1 turn; post-fix B is slot-blocked.
    await spinUntil(() => arrived("/stream-b"), OPEN_CHANCE_TURNS);
    expect(arrived("/stream-b")).toBe(false);
    expect(bSettled).toBe(false);
    // The crux: peak server-side concurrency never exceeded the cap of 1.
    expect(server.concurrentStreams()).toBe(1);
    expect(server.peakConcurrentStreams()).toBe(1);

    // End A's held stream. A's slot is released on the stream terminal, so B's
    // queued acquire now wakes and B opens its stream. (Only A is held at this
    // point, so this ends A alone.)
    server.releaseHeldStreams();
    await expect(readAll(aRes.body!)).resolves.toBe("chunk-1chunk-2");

    // B opens and responds only now that A's stream has terminated.
    const bRes = await bResP;
    expect(bRes.status).toBe(200);
    expect(bSettled).toBe(true);
    // B's stream is itself held open; end it so its body completes.
    server.releaseHeldStreams();
    await expect(readAll(bRes.body!)).resolves.toBe("chunk-1chunk-2");

    // Both ran, but never at the same time: the gate bounded OPEN streams.
    expect(server.requests.map((r) => r.path).sort()).toEqual([
      "/stream-a",
      "/stream-b",
    ]);
    expect(server.peakConcurrentStreams()).toBe(1);
  });

  it("default-off (cap unset): both requests open streams concurrently (byte-for-byte no-op)", async () => {
    server = await startH2FaultServer({
      command: { holdStreamOpenUntilRelease: true },
    });
    // No cap set: the gate must be a pure no-op (unlimited concurrency).
    pool = makePool();
    const h2fetch = createPoolBackedH2Fetch(pool, DOMAIN);

    const aRes = await h2fetch(new Request(`${server.url}/a`));
    const bRes = await h2fetch(new Request(`${server.url}/b`));
    expect(aRes.status).toBe(200);
    expect(bRes.status).toBe(200);

    // Both streams are held open AT THE SAME TIME: peak concurrency is 2, proving
    // the gate did not serialize them.
    expect(
      await spinUntil(() => server!.concurrentStreams() === 2, OPEN_CHANCE_TURNS),
    ).toBe(true);
    expect(server.peakConcurrentStreams()).toBe(2);

    server.releaseHeldStreams();
    await expect(readAll(aRes.body!)).resolves.toBe("chunk-1chunk-2");
    await expect(readAll(bRes.body!)).resolves.toBe("chunk-1chunk-2");
  });

  it("a long-open stream is not aborted/cancelled by the slot lifecycle (safety-timer is a non-disruptive backstop)", async () => {
    // With cap=1 and A's stream held open, A holds its slot for the whole open-
    // stream lifetime. The slot machinery (incl. the H2_SLOT_TIMEOUT_MS backstop)
    // must NEVER abort or cancel the underlying request/stream — it only frees
    // the queue slot. We assert this structurally, without a wall-clock wait:
    // A's still-open stream is never errored/closed by the slot path while held,
    // and ending it server-side delivers the full payload + a clean EOF (an
    // abort/cancel would instead surface an error on the body reader).
    server = await startH2FaultServer({
      command: { holdStreamOpenUntilRelease: true },
    });
    settings.config.maxConcurrentH2Requests = 1;
    pool = makePool();
    const h2fetch = createPoolBackedH2Fetch(pool, DOMAIN);

    const aRes = await h2fetch(new Request(`${server.url}/long-stream`));
    expect(aRes.status).toBe(200);
    const reader = (
      aRes.body as ReadableStream<Uint8Array>
    ).getReader();
    const decoder = new TextDecoder();

    // First chunk arrives and the body stream is open.
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decoder.decode(first.value)).toBe("chunk-1");

    // Spin the loop: nothing in the slot path errors or closes the still-open
    // stream while it is held (the no-abort property).
    await spinUntil(() => false, OPEN_CHANCE_TURNS);
    expect(server.concurrentStreams()).toBe(1);

    // The stream is intact: ending it server-side delivers the final chunk and a
    // clean EOF — never an abort/cancel error.
    server.releaseHeldStreams();
    const second = await reader.read();
    expect(second.done).toBe(false);
    expect(decoder.decode(second.value)).toBe("chunk-2");
    const end = await reader.read();
    expect(end.done).toBe(true);
  });
});
