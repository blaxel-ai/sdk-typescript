// Regression: ENG-2676 — H2Pool get/validate eviction race (FIXED).
//
// `validateEntry` does:
//     const { session } = entry;            // h2pool.ts  (captures session)
//     ...
//     if (await this.ping(session)) {       // awaits — yields!
//       ...
//       return session;                     // would return the CAPTURED session
//     }
// If an eviction listener (goaway/error/close -> attachEvictionListeners,
// h2pool.ts:61-75) deletes the entry from the map DURING the `await this.ping`,
// the pre-fix code still returned the now-stale `session` it captured before the
// await — the zombie ENG-2422 tried to kill, re-entering through the validate
// race. The fix (generation/identity pinning, ENG-2676) re-checks the map after
// the ping and refuses a session that is no longer the cached generation, so the
// caller falls through to establish a fresh one.
//
// This test drives the REAL H2Pool with a controllable MockSession whose
// `ping(cb)` HOLDS the callback, so we deterministically interleave a `goaway`
// eviction into the middle of the ping await, then assert get() does NOT hand
// back the evicted session. (Before ENG-2676 this was a live `it.fails`
// tripwire that passed only while the bug was present; it now asserts the
// correct post-fix behavior directly.)
import { EventEmitter } from "events";
import type http2 from "http2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { H2Pool } from "../../../@blaxel/core/src/common/h2pool.js";

const DOMAIN = "edge.race.example.com";

type EstablishHook = {
  _establish: (domain: string) => Promise<http2.ClientHttp2Session>;
};

/**
 * Controllable session stand-in. `ping(cb)` records and HOLDS the callback so a
 * test controls exactly when the liveness check resolves; events (`goaway`)
 * are emitted directly to trigger the pool's eviction listeners.
 */
class HoldPingSession extends EventEmitter {
  public closed = false;
  public destroyed = false;
  public pingCalls = 0;
  public heldPingCb: ((err?: Error | null) => void) | null = null;

  ping(cb?: (err?: Error | null) => void): boolean {
    this.pingCalls += 1;
    this.heldPingCb = cb ?? null;
    return true; // "sent" — the pool now waits for heldPingCb / its own timeout
  }
  close(): void {
    this.closed = true;
    this.emit("close");
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

let pool: H2Pool | undefined;

afterEach(() => {
  if (pool) pool.closeAll();
  pool = undefined;
  vi.restoreAllMocks();
});

describe("ENG-2676: H2Pool get/validate race", () => {
  it(
    "get() must NOT return a session evicted (goaway) during the ping await",
    async () => {
      let now = 1_000;
      const stale = new HoldPingSession();
      const fresh = new HoldPingSession();
      let establishCount = 0;

      // Large pingTimeoutMs so the pool waits on our held callback, never its timer.
      pool = new H2Pool({ maxIdleMs: 50, pingTimeoutMs: 10_000, now: () => now });
      (pool as unknown as EstablishHook)._establish = (() => {
        establishCount += 1;
        const s = establishCount === 1 ? stale : fresh;
        return Promise.resolve(s as unknown as http2.ClientHttp2Session);
      }) as EstablishHook["_establish"];

      // Cache the (soon-to-be-stale) session and attach eviction listeners.
      const firstSession = await pool.get(DOMAIN);
      expect(firstSession === (stale as unknown)).toBe(true);

      // Make the entry idle so the next get() runs validateEntry -> ping.
      now += 1_000;

      // Start get(): validateEntry captures `session`, then awaits ping (held).
      const getPromise = pool.get(DOMAIN);
      await tick();
      expect(stale.pingCalls).toBe(1);
      expect(stale.heldPingCb).not.toBeNull();

      // DURING the held ping, the session emits goaway -> eviction listener
      // deletes it from the pool's map (h2pool.ts:61-75).
      stale.emit("goaway");
      await tick();

      // Now resolve the held ping as SUCCESS (the trap: validate returns the
      // captured-but-now-evicted session).
      stale.heldPingCb!(null);

      const got = await getPromise;

      // Post-ENG-2676: the evicted session must not be handed out. get() falls
      // through past the pinned (now-evicted) entry and establishes a fresh
      // session, so `got` is the fresh one — never the evicted `stale`.
      expect(got === (stale as unknown)).toBe(false);
    },
  );
});
