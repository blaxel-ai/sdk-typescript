// H2Pool.warm() / closeAll() unit tests.
//
// `warm(domain)` is the fire-and-forget background connect the SDK kicks off in
// parallel with createSandbox() so the first real call pays no TLS/SETTINGS RTT
// (see h2warm.ts). Its behavior — cache on success, de-duplicate concurrent
// warms, let a racing get() JOIN the in-flight warm rather than opening a second
// session, and swallow connect failures instead of throwing into a floating
// promise — is load-bearing for the cold-start latency win but was previously
// only exercised indirectly. These drive a real H2Pool with a controllable
// establish hook so each warm branch is asserted directly. No socket, no creds.
import { EventEmitter } from "events";
import type http2 from "http2";
import { describe, expect, it } from "vitest";
import { H2Pool } from "../../@blaxel/core/src/common/h2pool.js";

class MockSession extends EventEmitter {
  public closed = false;
  public destroyed = false;
  close(): void {
    this.closed = true;
    this.emit("close");
  }
  ping(cb: (err?: Error | null) => void): boolean {
    setImmediate(() => cb(null));
    return true;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

function asSession(s: MockSession): http2.ClientHttp2Session {
  return s as unknown as http2.ClientHttp2Session;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

async function waitFor(fn: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await tick();
  }
}

/** Install an establish hook that returns whatever the factory yields. */
function withEstablish(
  pool: H2Pool,
  factory: (domain: string) => Promise<http2.ClientHttp2Session>,
): void {
  (pool as unknown as { _establish: (d: string) => Promise<http2.ClientHttp2Session> })._establish =
    factory;
}

describe("H2Pool.warm", () => {
  it("caches the session in the background so a later tryGet finds it", async () => {
    let count = 0;
    const pool = new H2Pool();
    withEstablish(pool, () => {
      count += 1;
      return Promise.resolve(asSession(new MockSession()));
    });

    expect(pool.tryGet("edge.example.com")).toBeNull();
    pool.warm("edge.example.com");
    await waitFor(() => pool.tryGet("edge.example.com") !== null);

    expect(count).toBe(1);
    expect(pool.tryGet("edge.example.com")).not.toBeNull();
  });

  it("is a no-op when a live session is already cached", async () => {
    let count = 0;
    const pool = new H2Pool();
    withEstablish(pool, () => {
      count += 1;
      return Promise.resolve(asSession(new MockSession()));
    });

    pool.warm("edge.example.com");
    await waitFor(() => pool.tryGet("edge.example.com") !== null);
    expect(count).toBe(1);

    // Second warm sees the cached session and does not establish again.
    pool.warm("edge.example.com");
    await tick();
    expect(count).toBe(1);
  });

  it("de-duplicates concurrent warms into a single connection attempt", async () => {
    let count = 0;
    const gate = deferred<http2.ClientHttp2Session>();
    const pool = new H2Pool();
    withEstablish(pool, () => {
      count += 1;
      return gate.promise;
    });

    // Fire three warms before the first connection resolves.
    pool.warm("edge.example.com");
    pool.warm("edge.example.com");
    pool.warm("edge.example.com");
    await tick();
    expect(count).toBe(1); // only one establish in flight

    gate.resolve(asSession(new MockSession()));
    await waitFor(() => pool.tryGet("edge.example.com") !== null);
    expect(count).toBe(1);
  });

  it("lets a racing get() join the in-flight warm instead of opening a second session", async () => {
    let count = 0;
    const gate = deferred<http2.ClientHttp2Session>();
    const pool = new H2Pool();
    withEstablish(pool, () => {
      count += 1;
      return gate.promise;
    });

    pool.warm("edge.example.com");
    await tick();
    const getPromise = pool.get("edge.example.com");

    const session = asSession(new MockSession());
    gate.resolve(session);

    await expect(getPromise).resolves.toBe(session);
    expect(count).toBe(1); // get joined the warm; no second establish
    expect(pool.tryGet("edge.example.com")).toBe(session);
  });

  it("swallows a failed connection: nothing is cached and no error is thrown", async () => {
    let count = 0;
    const pool = new H2Pool();
    withEstablish(pool, () => {
      count += 1;
      return Promise.reject(new Error("connect refused"));
    });

    // warm() must not throw synchronously nor produce an unhandled rejection.
    expect(() => pool.warm("edge.example.com")).not.toThrow();
    await tick();
    await tick();

    expect(count).toBe(1);
    expect(pool.tryGet("edge.example.com")).toBeNull();

    // A subsequent warm can retry (the inflight slot was cleared).
    withEstablish(pool, () => {
      count += 1;
      return Promise.resolve(asSession(new MockSession()));
    });
    pool.warm("edge.example.com");
    await waitFor(() => pool.tryGet("edge.example.com") !== null);
    expect(count).toBe(2);
  });
});

describe("H2Pool.closeAll", () => {
  it("closes every cached session and clears the cache", async () => {
    const sessions: MockSession[] = [];
    const pool = new H2Pool();
    withEstablish(pool, () => {
      const s = new MockSession();
      sessions.push(s);
      return Promise.resolve(asSession(s));
    });

    await pool.get("edge.a.example.com");
    await pool.get("edge.b.example.com");
    expect(sessions).toHaveLength(2);
    expect(pool.tryGet("edge.a.example.com")).not.toBeNull();

    pool.closeAll();

    expect(sessions.every((s) => s.closed)).toBe(true);
    expect(pool.tryGet("edge.a.example.com")).toBeNull();
    expect(pool.tryGet("edge.b.example.com")).toBeNull();
  });

  it("is safe to call with nothing pooled", () => {
    const pool = new H2Pool();
    expect(() => pool.closeAll()).not.toThrow();
  });
});
