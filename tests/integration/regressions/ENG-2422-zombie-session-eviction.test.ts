// Regression: ENG-2422
//
// ENG-2422: a pooled H2 session zombified after a long external fetch and the
// next sandbox call hung on it. The fix (h2pool.ts) added (a) idle-ping
// validation before reuse (`validateEntry` -> `ping`, h2pool.ts:134-154) and
// (b) self-healing eviction listeners that delete the cached session as soon as
// it emits `goaway`/`error`/`close` (`attachEvictionListeners`, h2pool.ts:61-75).
//
// These tests wire a REAL `ClientHttp2Session` from the fault harness into a
// REAL `H2Pool` via the documented `_establish` hook, with a small `maxIdleMs`
// + an injected `now` so we can force the idle/ping path deterministically, and
// a small `pingTimeoutMs` so a non-answering ping resolves quickly.
//
// FINDING (verified empirically below, and the crux of the ENG-2422 subtlety):
// Node's `http2` answers PING frames at the protocol level automatically. A
// session that is socket-alive but DRAINING / refusing new streams still
// answers PINGs "ok", so the pool's idle-ping liveness check reports it healthy
// even though a real `session.request()` immediately fails. The idle-ping check
// therefore CANNOT detect that class of zombie. The ENG-2422 fix actually
// guards the cases this corpus covers: a session that has become
// closed/destroyed (Case A: socket dropped -> `close`/`error` eviction) and a
// session whose ping does not return in time (Case B: ping timeout -> evict).
// The PING-healthy-but-draining gap is demonstrated as a live test below and is
// tracked for the pooling / rate-shaping work (ENG-2681) and generation pinning
// (ENG-2676); it is NOT closed by ENG-2422.
//
// Determinism: no wall-clock waits drive control flow. Idle is forced via the
// injected `now`; ping failure is forced by stubbing the real session's `ping`
// to never answer so the pool's own `pingTimeoutMs` fires (60ms). Comparisons
// use raw `===`/`!==` because chai's `toBe(session)` introspects a real
// `ClientHttp2Session` and throws "this is not a typed array".
import http2 from "http2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { H2Pool } from "../../../@blaxel/core/src/common/h2pool.js";
import {
  startH2FaultServer,
  type H2FaultServer,
} from "../fault-injection/h2-fault-server.js";

const DOMAIN = "edge.zombie.example.com";

type EstablishHook = {
  _establish: (domain: string) => Promise<http2.ClientHttp2Session>;
};

let server: H2FaultServer | undefined;
let pool: H2Pool | undefined;

afterEach(async () => {
  if (pool) pool.closeAll();
  pool = undefined;
  if (server) await server.close();
  server = undefined;
  vi.restoreAllMocks();
});

/** Wire a real H2Pool whose establish() returns a fresh real harness session. */
function makePool(now: () => number): {
  pool: H2Pool;
  established: http2.ClientHttp2Session[];
} {
  const established: http2.ClientHttp2Session[] = [];
  const p = new H2Pool({ maxIdleMs: 50, pingTimeoutMs: 60, now });
  (p as unknown as EstablishHook)._establish = () => {
    const s = server!.connectClient();
    established.push(s);
    return Promise.resolve(s);
  };
  return { pool: p, established };
}

describe("ENG-2422: zombie H2 session is evicted, never handed out", () => {
  it("Case A: a dropped (close/error) session is evicted; get() returns a fresh, usable one", async () => {
    server = await startH2FaultServer();
    let now = 1_000;
    const made = makePool(() => now);
    pool = made.pool;

    // Cache a real session via get().
    const first = await pool.get(DOMAIN);
    expect(first).not.toBeNull();
    expect(pool.isUsable(first!)).toBe(true);

    // Drop it server-side by destroying the client session; the eviction
    // listener fires on `close`, removing it from the cache.
    const closed = new Promise<void>((resolve) =>
      first!.once("close", () => resolve()),
    );
    first!.destroy();
    await closed;

    // Advance past idle for good measure, then ask again.
    now += 1_000;
    const second = await pool.get(DOMAIN);

    // The dead session must NOT be handed back: a different, usable session
    // (freshly established) is returned instead.
    expect(second === first).toBe(false);
    expect(second).not.toBeNull();
    expect(second!.closed).toBe(false);
    expect(second!.destroyed).toBe(false);
    expect(pool.isUsable(second!)).toBe(true);
    expect(made.established.length).toBe(2);
  });

  it("Case B: an idle session whose ping does not answer is evicted (ping timeout), not handed out", async () => {
    server = await startH2FaultServer();
    let now = 1_000;
    const made = makePool(() => now);
    pool = made.pool;

    const first = await pool.get(DOMAIN);
    expect(first).not.toBeNull();

    // Make the cached entry idle so the next get() runs the ping liveness check.
    now += 1_000;

    // Force the ping to never answer so the pool's pingTimeoutMs (60ms) fires
    // and the session is treated as dead. (Killing the loopback server does not
    // reliably make a ping fail: the socket is fast and Node auto-answers, so we
    // drive the timeout branch deterministically by holding the callback.)
    let pingCalled = false;
    vi.spyOn(first!, "ping").mockImplementation(((
      cb?: (err?: Error | null) => void,
    ) => {
      pingCalled = true;
      void cb; // intentionally never invoked -> pool ping times out
      return true; // report "sent" so the pool waits on the (never-coming) reply
    }) as unknown as http2.ClientHttp2Session["ping"]);

    const second = await pool.get(DOMAIN);

    // The pool pinged the idle session, the ping timed out, the session was
    // evicted, and a fresh one was established instead.
    expect(pingCalled).toBe(true);
    expect(second === first).toBe(false);
    expect(second).not.toBeNull();
    expect(pool.isUsable(second!)).toBe(true);
    expect(made.established.length).toBe(2);
  });

  it("FINDING gap: a PING-healthy but stream-refusing session is reported live, yet a real request fails", async () => {
    // The server refuses every new stream with REFUSED_STREAM but keeps the
    // connection (and thus PING) alive — the shape of a draining edge.
    server = await startH2FaultServer({
      command: { rstStreamWith: { code: http2.constants.NGHTTP2_REFUSED_STREAM } },
    });
    const session = server.connectClient();
    await new Promise<void>((resolve) => session.once("connect", () => resolve()));

    // 1) A protocol-level PING is answered: the liveness check the pool relies
    //    on would call this session "healthy".
    const pingHealthy = await new Promise<boolean>((resolve) => {
      const sent = session.ping((err?: Error | null) => resolve(!err));
      if (!sent) resolve(false);
    });
    expect(pingHealthy).toBe(true);
    expect(session.closed).toBe(false);
    expect(session.destroyed).toBe(false);

    // 2) ...yet an actual request on that same "healthy" session fails. This is
    //    the zombie the idle-ping check cannot see (ENG-2681 / ENG-2676).
    const requestError = await new Promise<NodeJS.ErrnoException | null>(
      (resolve) => {
        const req = session.request({ ":path": "/x", ":method": "GET" });
        req.on("response", () => resolve(null));
        req.on("error", (err: NodeJS.ErrnoException) => resolve(err));
        req.end();
      },
    );
    expect(requestError).not.toBeNull();
    expect(requestError!.code).toBe("ERR_HTTP2_STREAM_ERROR");

    session.destroy();
  });
});
