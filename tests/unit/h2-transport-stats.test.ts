import { EventEmitter } from "events";
import type http2 from "http2";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createH2Fetch,
  createPoolBackedH2Fetch,
  h2RequestDirectFromPool,
} from "../../@blaxel/core/src/common/h2fetch.js";
import { H2Pool } from "../../@blaxel/core/src/common/h2pool.js";
import { h2TransportStats } from "../../@blaxel/core/src/common/h2stats.js";
import { logger } from "../../@blaxel/core/src/common/logger.js";

class MockStream extends EventEmitter {
  resume(): void {}
  close(): void {}
  end(): void {
    queueMicrotask(() => {
      this.emit("response", { ":status": 200 });
      this.emit("end");
    });
  }
}

class MockSession extends EventEmitter {
  closed = false;
  destroyed = false;

  request(): MockStream {
    return new MockStream();
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }

  ping(callback: (error?: Error | null) => void): boolean {
    queueMicrotask(() => callback(null));
    return true;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

function asSession(session: MockSession): http2.ClientHttp2Session {
  return session as unknown as http2.ClientHttp2Session;
}

function withEstablish(
  pool: H2Pool,
  establish: (domain: string) => Promise<http2.ClientHttp2Session>,
): void {
  (pool as unknown as { _establish: typeof establish })._establish = establish;
}

const noopLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

describe("h2TransportStats", () => {
  afterEach(() => {
    h2TransportStats.reset();
    logger.setLogger(noopLogger);
    vi.restoreAllMocks();
  });

  it("counts and logs an establishment failure followed by a fetch fallback", async () => {
    const messages: string[] = [];
    logger.setLogger({ ...noopLogger, debug: (message) => messages.push(message) });
    const pool = new H2Pool();
    withEstablish(pool, () => Promise.reject(new Error("connect refused")));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fallback"));

    const request = createPoolBackedH2Fetch(pool, "edge.example.com");
    const response = await request(new Request("https://edge.example.com/process"));

    expect(await response.text()).toBe("fallback");
    expect(h2TransportStats.snapshot()).toEqual({
      establishFailures: 1,
      fetchFallbacks: 1,
      fallbacksByReason: {
        "no-session": 1,
        "request-rejected": 0,
        "session-unusable": 0,
        "unsupported-body": 0,
      },
      byDomain: {
        "edge.example.com": {
          establishFailures: 1,
          fetchFallbacks: 1,
          fallbacksByReason: {
            "no-session": 1,
            "request-rejected": 0,
            "session-unusable": 0,
            "unsupported-body": 0,
          },
        },
      },
    });
    expect(messages).toEqual([
      "H2 session establishment failed for edge.example.com: connect refused",
      "H2 transport falling back to fetch for edge.example.com: no-session",
    ]);
  });

  it("counts every fallback in a concurrent burst while deduplicating establishment", async () => {
    const pool = new H2Pool();
    let establishAttempts = 0;
    withEstablish(pool, () => {
      establishAttempts++;
      return Promise.reject(new Error("connect refused"));
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fallback"));
    const request = createPoolBackedH2Fetch(pool, "edge.example.com");

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        request(new Request(`https://edge.example.com/process/${index}`)),
      ),
    );

    const snapshot = h2TransportStats.snapshot();
    expect(establishAttempts).toBe(2);
    expect(snapshot.establishFailures).toBe(2);
    expect(snapshot.fetchFallbacks).toBe(20);
    expect(snapshot.fallbacksByReason["no-session"]).toBe(20);
    expect(snapshot.byDomain["edge.example.com"]?.fetchFallbacks).toBe(20);
  });

  it("records nothing when the H2 request succeeds", async () => {
    const pool = new H2Pool();
    withEstablish(pool, () => Promise.resolve(asSession(new MockSession())));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const request = createPoolBackedH2Fetch(pool, "edge.example.com");

    const response = await request(new Request("https://edge.example.com/process"));
    await response.text();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h2TransportStats.snapshot()).toEqual({
      establishFailures: 0,
      fetchFallbacks: 0,
      fallbacksByReason: {
        "no-session": 0,
        "request-rejected": 0,
        "session-unusable": 0,
        "unsupported-body": 0,
      },
      byDomain: {},
    });
  });

  it("counts an unusable-session fallback", async () => {
    const pool = new H2Pool();
    const session = new MockSession();
    session.closed = true;
    withEstablish(pool, () => Promise.resolve(asSession(session)));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fallback"));

    await h2RequestDirectFromPool(
      pool,
      "edge.example.com",
      "https://edge.example.com/process",
    );

    expect(h2TransportStats.snapshot().fallbacksByReason).toEqual({
      "no-session": 0,
      "request-rejected": 0,
      "session-unusable": 1,
      "unsupported-body": 0,
    });
  });

  it("counts an unsupported-body fallback", async () => {
    const pool = new H2Pool();
    withEstablish(pool, () => Promise.resolve(asSession(new MockSession())));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fallback"));
    const body = new FormData();
    body.append("file", new Blob(["content"]), "file.txt");

    await h2RequestDirectFromPool(
      pool,
      "edge.example.com",
      "https://edge.example.com/files",
      { method: "PUT", body },
    );

    expect(h2TransportStats.snapshot().fallbacksByReason).toEqual({
      "no-session": 0,
      "request-rejected": 0,
      "session-unusable": 0,
      "unsupported-body": 1,
    });
  });

  it("counts a synchronous session request rejection separately", async () => {
    const pool = new H2Pool();
    const session = new MockSession();
    vi.spyOn(session, "request").mockImplementation(() => {
      throw new Error("session rejected request");
    });
    withEstablish(pool, () => Promise.resolve(asSession(session)));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fallback"));
    const request = createPoolBackedH2Fetch(pool, "edge.example.com");

    await request(new Request("https://edge.example.com/process"));

    expect(h2TransportStats.snapshot().fallbacksByReason).toEqual({
      "no-session": 0,
      "request-rejected": 1,
      "session-unusable": 0,
      "unsupported-body": 0,
    });
  });

  it("bounds per-domain retention without losing aggregate totals", async () => {
    const session = new MockSession();
    session.closed = true;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fallback"));
    const request = createH2Fetch(asSession(session));

    await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        request(new Request(`https://edge-${index}.example.com/process`)),
      ),
    );

    const snapshot = h2TransportStats.snapshot();
    expect(snapshot.fetchFallbacks).toBe(101);
    expect(Object.keys(snapshot.byDomain)).toHaveLength(100);
    expect(snapshot.byDomain["edge-0.example.com"]).toBeUndefined();
    expect(snapshot.byDomain["edge-100.example.com"]?.fetchFallbacks).toBe(1);
  });

  it("preserves fallback behavior when the debug logger throws", async () => {
    logger.setLogger({
      ...noopLogger,
      debug: () => {
        throw new Error("logger failed");
      },
    });
    const pool = new H2Pool();
    withEstablish(pool, () => Promise.reject(new Error("connect refused")));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fallback"));
    const request = createPoolBackedH2Fetch(pool, "edge.example.com");

    const response = await request(new Request("https://edge.example.com/process"));

    expect(await response.text()).toBe("fallback");
    expect(h2TransportStats.snapshot().fetchFallbacks).toBe(1);
  });

  it("reset clears all counters", async () => {
    const pool = new H2Pool();
    withEstablish(pool, () => Promise.reject(new Error("connect refused")));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fallback"));
    const request = createPoolBackedH2Fetch(pool, "edge.example.com");
    await request(new Request("https://edge.example.com/process"));

    h2TransportStats.reset();

    expect(h2TransportStats.snapshot()).toEqual({
      establishFailures: 0,
      fetchFallbacks: 0,
      fallbacksByReason: {
        "no-session": 0,
        "request-rejected": 0,
        "session-unusable": 0,
        "unsupported-body": 0,
      },
      byDomain: {},
    });
  });
});
