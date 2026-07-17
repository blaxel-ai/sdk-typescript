// Unit: H2Pool multi-session pooling (round-robin + warm-to-N).
//
// The pool keeps up to `maxConnections` warm sessions per domain and
// round-robins requests across them so a burst of concurrent creates/execs
// spreads over several connections instead of one saturated session. With
// `maxConnections = 1` it must behave exactly like the historical
// single-session pool.
import { EventEmitter } from "events";
import type http2 from "http2";
import { afterEach, describe, expect, it } from "vitest";
import { H2Pool } from "../../@blaxel/core/src/common/h2pool.js";

class MockSession extends EventEmitter {
  public closed = false;
  public destroyed = false;
  ping(cb?: (err?: Error | null) => void): boolean {
    if (cb) cb(null);
    return true;
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

type EstablishHook = {
  _establish: (domain: string) => Promise<http2.ClientHttp2Session>;
};

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const DOMAIN = "any.us-east-1.bl.run";

let pool: H2Pool | undefined;

afterEach(() => {
  if (pool) pool.closeAll();
  pool = undefined;
});

/** Build a pool whose establish() hands out a fresh distinct MockSession. */
function makePool(maxConnections: number | (() => number)): {
  pool: H2Pool;
  established: MockSession[];
} {
  const established: MockSession[] = [];
  const p = new H2Pool({ maxConnections });
  (p as unknown as EstablishHook)._establish = () => {
    const s = new MockSession();
    established.push(s);
    return Promise.resolve(s as unknown as http2.ClientHttp2Session);
  };
  return { pool: p, established };
}

describe("H2Pool multi-session", () => {
  it("warm() opens up to maxConnections sessions for a domain", async () => {
    const made = makePool(4);
    pool = made.pool;

    pool.warm(DOMAIN);
    // Allow the background establishes to settle.
    await tick();
    await tick();

    expect(made.established).toHaveLength(4);

    // Warming again is a no-op while the pool is full.
    pool.warm(DOMAIN);
    await tick();
    expect(made.established).toHaveLength(4);
  });

  it("get() round-robins across the warm sessions", async () => {
    const made = makePool(3);
    pool = made.pool;

    pool.warm(DOMAIN);
    await tick();
    await tick();
    expect(made.established).toHaveLength(3);

    const seen: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      seen.push(await pool.get(DOMAIN));
    }

    // Six gets over three sessions => each distinct session used exactly twice.
    const unique = new Set(seen);
    expect(unique.size).toBe(3);
    for (const s of unique) {
      expect(seen.filter((x) => x === s)).toHaveLength(2);
    }
  });

  it("sequential get() stays on a single connection (no eager growth)", async () => {
    const made = makePool(3);
    pool = made.pool;

    // Growth is demand-driven: with no concurrent in-flight requests, repeated
    // sequential gets reuse the one warm connection instead of opening more.
    await pool.get(DOMAIN);
    await pool.get(DOMAIN);
    await pool.get(DOMAIN);
    await tick();
    await tick();

    expect(made.established.length).toBe(1);
  });

  it("concurrent demand fans the pool out toward maxConnections", async () => {
    const made = makePool(3);
    pool = made.pool;

    // Simulate the h2fetch gateway marking several requests in-flight for the
    // domain, then a burst of concurrent get()s. Demand > live capacity, so the
    // pool grows one connection per get() up to the cap.
    pool.noteRequestStart(DOMAIN);
    pool.noteRequestStart(DOMAIN);
    pool.noteRequestStart(DOMAIN);
    pool.noteRequestStart(DOMAIN);
    await Promise.all([
      pool.get(DOMAIN),
      pool.get(DOMAIN),
      pool.get(DOMAIN),
      pool.get(DOMAIN),
    ]);
    await tick();
    await tick();
    await tick();

    // Never exceeds the cap even though demand (4) is higher.
    expect(made.established.length).toBe(3);

    pool.noteRequestEnd(DOMAIN);
    pool.noteRequestEnd(DOMAIN);
    pool.noteRequestEnd(DOMAIN);
    pool.noteRequestEnd(DOMAIN);
  });

  it("maxConnections = 1 keeps single-session behavior (one connection reused)", async () => {
    const made = makePool(1);
    pool = made.pool;

    const a = await pool.get(DOMAIN);
    const b = await pool.get(DOMAIN);
    const c = await pool.get(DOMAIN);
    await tick();

    expect(made.established).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("re-reads a functional maxConnections so config changes take effect", async () => {
    let size = 2;
    const made = makePool(() => size);
    pool = made.pool;

    pool.warm(DOMAIN);
    await tick();
    await tick();
    expect(made.established).toHaveLength(2);

    size = 5;
    pool.warm(DOMAIN);
    await tick();
    await tick();
    expect(made.established).toHaveLength(5);
  });

  it("evicts a closed session and warm() refills it", async () => {
    const made = makePool(3);
    pool = made.pool;

    pool.warm(DOMAIN);
    await tick();
    await tick();
    expect(made.established).toHaveLength(3);

    // Kill one session; its 'close' listener removes it from the pool.
    made.established[0].close();
    await tick();

    pool.warm(DOMAIN);
    await tick();
    await tick();

    // One replacement established (4 total create calls, 3 live).
    expect(made.established).toHaveLength(4);
  });
});
