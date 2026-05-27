import { EventEmitter } from "events";
import type http2 from "http2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPoolBackedH2Fetch,
  h2RequestDirectFromPool,
} from "../../@blaxel/core/src/common/h2fetch.js";
import { H2Pool } from "../../@blaxel/core/src/common/h2pool.js";
import { settings } from "../../@blaxel/core/src/common/settings.js";

/**
 * Minimal ClientHttp2Stream stand-in. Tests drive the response lifecycle by
 * emitting events directly, so end()/close() are effectively no-ops.
 */
class MockStream extends EventEmitter {
  public closed = false;
  close(): void {
    this.closed = true;
  }
  end(): void {
    // no-op
  }
}

/**
 * Minimal ClientHttp2Session stand-in. `request()` records the stream so the
 * test can resolve or fail it on demand.
 */
class MockSession extends EventEmitter {
  public closed = false;
  public destroyed = false;
  public lastStream: MockStream | null = null;
  public streams: MockStream[] = [];

  request(): MockStream {
    const stream = new MockStream();
    this.lastStream = stream;
    this.streams.push(stream);
    return stream;
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

function asSession(mock: MockSession): http2.ClientHttp2Session {
  return mock as unknown as http2.ClientHttp2Session;
}

/**
 * Build a pool whose establish() always returns the supplied session for any
 * domain, so each domain gets its own cached session without real network.
 */
function poolReturning(
  sessionForDomain: (domain: string) => MockSession | null,
): H2Pool {
  const pool = new H2Pool();
  (pool as unknown as { _establish: (d: string) => Promise<MockSession | null> })._establish =
    (domain: string) => Promise.resolve(sessionForDomain(domain));
  return pool;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function resolveStream(stream: MockStream, status = 200): void {
  stream.emit("response", { ":status": status });
  stream.emit("end");
}

describe("h2fetch per-domain concurrency cap", () => {
  beforeEach(() => {
    // Cap concurrency at 1 in-flight request per domain so blocking is easy
    // to observe deterministically.
    settings.config.maxConcurrentH2Requests = 1;
  });

  afterEach(() => {
    delete settings.config.maxConcurrentH2Requests;
    vi.restoreAllMocks();
  });

  it("releases the slot after an H2 success so the next request can proceed", async () => {
    const session = new MockSession();
    const pool = poolReturning(() => session);
    const h2fetch = createPoolBackedH2Fetch(pool, "edge.a.example.com");

    const first = h2fetch(new Request("http://a.example.com/one"));
    await tick();
    const firstStream = session.lastStream!;
    expect(firstStream).not.toBeNull();

    // A second request must not get an H2 stream until the first releases.
    const second = h2fetch(new Request("http://a.example.com/two"));
    await tick();
    expect(session.streams).toHaveLength(1);

    resolveStream(firstStream);
    await first;

    // First slot released: the second request now opens its own stream.
    await tick();
    expect(session.streams).toHaveLength(2);
    resolveStream(session.lastStream!);
    await second;
  });

  it("releases the slot after an H2 error so the next request can proceed", async () => {
    const session = new MockSession();
    const pool = poolReturning(() => session);
    const h2fetch = createPoolBackedH2Fetch(pool, "edge.b.example.com");

    const first = h2fetch(new Request("http://b.example.com/one", { method: "POST", body: "x" }));
    await tick();
    const firstStream = session.lastStream!;

    const second = h2fetch(new Request("http://b.example.com/two", { method: "POST", body: "y" }));
    await tick();
    expect(session.streams).toHaveLength(1);

    firstStream.emit("error", new Error("stream dead"));
    await expect(first).rejects.toThrow("stream dead");

    // Slot freed despite the error: the queued request now runs.
    await tick();
    expect(session.streams).toHaveLength(2);
    resolveStream(session.lastStream!);
    await second;
  });

  it("releases the slot when there is no usable session (fetch fallback)", async () => {
    // Pool returns null (no session), exercising the globalThis.fetch fallback
    // path. The slot must still be released so a follow-up request proceeds.
    const pool = poolReturning(() => null);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(new Response("fallback")));

    const h2fetch = createPoolBackedH2Fetch(pool, "edge.c.example.com");

    const first = await h2fetch(new Request("http://c.example.com/one"));
    expect(await first.text()).toBe("fallback");

    const second = await h2fetch(new Request("http://c.example.com/two"));
    expect(await second.text()).toBe("fallback");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("releases the slot when a post-flight error evicts the pooled session", async () => {
    const session = new MockSession();
    const pool = poolReturning(() => session);
    const h2fetch = createPoolBackedH2Fetch(pool, "edge.evict.example.com");

    // Prime the pool so the session is cached and observable via tryGet().
    const first = h2fetch(
      new Request("http://evict.example.com/one", { method: "POST", body: "x" }),
    );
    await tick();
    const firstStream = session.lastStream!;
    expect(pool.tryGet("edge.evict.example.com")).toBe(session);

    // A second request queues behind the single slot.
    const second = h2fetch(
      new Request("http://evict.example.com/two", { method: "POST", body: "y" }),
    );
    await tick();
    expect(session.streams).toHaveLength(1);

    // Post-flight stream error -> session evicted from the pool AND slot freed.
    firstStream.emit("error", new Error("stream dead"));
    await expect(first).rejects.toThrow("stream dead");
    expect(pool.tryGet("edge.evict.example.com")).toBeNull();

    // Slot was released despite the eviction: the queued request proceeds.
    await tick();
    expect(session.streams).toHaveLength(2);
    resolveStream(session.lastStream!);
    await second;
  });

  it("releases the slot on the globalThis.fetch fallback path (h2RequestDirectFromPool)", async () => {
    const pool = poolReturning(() => null);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(new Response("fallback")));

    const r1 = await h2RequestDirectFromPool(pool, "edge.d.example.com", "http://d.example.com/one");
    const r2 = await h2RequestDirectFromPool(pool, "edge.d.example.com", "http://d.example.com/two");

    expect(await r1.text()).toBe("fallback");
    expect(await r2.text()).toBe("fallback");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("releases the slot on the unsupported-body fetch fallback (pre-flight)", async () => {
    const session = new MockSession();
    const requestSpy = vi.spyOn(session, "request");
    const pool = poolReturning(() => session);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(new Response("fallback")));

    // FormData cannot be serialized to a Buffer for manual H2 framing, so the
    // direct-from-pool path falls back to globalThis.fetch before opening a
    // stream. The slot acquired around the call must still be released.
    const form1 = new FormData();
    form1.append("file", new Blob(["a"]), "a.txt");
    const r1 = await h2RequestDirectFromPool(
      pool,
      "edge.e.example.com",
      "http://e.example.com/one",
      { method: "PUT", body: form1 },
    );

    const form2 = new FormData();
    form2.append("file", new Blob(["b"]), "b.txt");
    const r2 = await h2RequestDirectFromPool(
      pool,
      "edge.e.example.com",
      "http://e.example.com/two",
      { method: "PUT", body: form2 },
    );

    expect(await r1.text()).toBe("fallback");
    expect(await r2.text()).toBe("fallback");
    expect(requestSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("serves queued requests in FIFO order", async () => {
    const session = new MockSession();
    const pool = poolReturning(() => session);
    const h2fetch = createPoolBackedH2Fetch(pool, "edge.f.example.com");
    const order: number[] = [];

    // One request holds the single slot; two more queue behind it.
    const p1 = h2fetch(new Request("http://f.example.com/1")).then(() => order.push(1));
    await tick();
    const holdingStream = session.lastStream!;

    const p2 = h2fetch(new Request("http://f.example.com/2")).then(() => order.push(2));
    await tick();
    const p3 = h2fetch(new Request("http://f.example.com/3")).then(() => order.push(3));
    await tick();

    // Only the first request has opened a stream so far.
    expect(session.streams).toHaveLength(1);

    // Release in sequence; each release should let exactly the next queued
    // request (in arrival order) open its stream.
    resolveStream(holdingStream);
    await p1;
    await tick();
    expect(session.streams).toHaveLength(2);

    resolveStream(session.streams[1]);
    await p2;
    await tick();
    expect(session.streams).toHaveLength(3);

    resolveStream(session.streams[2]);
    await p3;

    expect(order).toEqual([1, 2, 3]);
  });

  it("does not let one capped domain block an unrelated domain", async () => {
    const sessionA = new MockSession();
    const sessionB = new MockSession();
    const pool = poolReturning((domain) =>
      domain === "edge.A.example.com" ? sessionA : sessionB,
    );

    const fetchA = createPoolBackedH2Fetch(pool, "edge.A.example.com");
    const fetchB = createPoolBackedH2Fetch(pool, "edge.B.example.com");

    // Saturate domain A's single slot and queue a second A request behind it.
    const a1 = fetchA(new Request("http://a/one"));
    await tick();
    const a1Stream = sessionA.lastStream!;
    const a2 = fetchA(new Request("http://a/two"));
    await tick();
    expect(sessionA.streams).toHaveLength(1); // a2 is queued, blocked.

    // Domain B must be completely unaffected: it gets its slot immediately.
    const b1 = fetchB(new Request("http://b/one"));
    await tick();
    expect(sessionB.streams).toHaveLength(1);
    resolveStream(sessionB.lastStream!);
    await expect(b1).resolves.toBeInstanceOf(Response);

    // Now drain domain A.
    resolveStream(a1Stream);
    await a1;
    await tick();
    expect(sessionA.streams).toHaveLength(2);
    resolveStream(sessionA.streams[1]);
    await a2;
  });

  it("is a no-op when the cap is unset (default behavior, unlimited concurrency)", async () => {
    delete settings.config.maxConcurrentH2Requests;
    const session = new MockSession();
    const pool = poolReturning(() => session);
    const h2fetch = createPoolBackedH2Fetch(pool, "edge.g.example.com");

    // With no cap, multiple requests open streams concurrently without waiting
    // for each other to release.
    void h2fetch(new Request("http://g/1"));
    void h2fetch(new Request("http://g/2"));
    void h2fetch(new Request("http://g/3"));
    await tick();

    expect(session.streams.length).toBe(3);
  });
});
