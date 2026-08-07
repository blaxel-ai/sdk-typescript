import { EventEmitter } from "events";
import type http2 from "http2";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  H2Pool as H2PoolInstance,
  H2PoolOptions,
} from "../../../@blaxel/core/dist/cjs/types/common/h2pool.js";

const { establishH2Mock } = vi.hoisted(() => ({
  establishH2Mock: vi.fn<() => Promise<http2.ClientHttp2Session>>(),
}));

vi.mock("../../../@blaxel/core/dist/esm/common/h2warm.js", () => ({
  establishH2: establishH2Mock,
}));

// @ts-expect-error The internal ESM build does not emit co-located declarations.
import { H2Pool as CompiledH2Pool } from "../../../@blaxel/core/dist/esm/common/h2pool.js";

const H2Pool = CompiledH2Pool as new (options?: H2PoolOptions) => H2PoolInstance;

const DOMAIN = "edge.concurrent-ping.example.com";

class PingSession extends EventEmitter {
  closed = false;
  destroyed = false;
  pingCalls = 0;
  closeCalls = 0;
  private pingCallbacks: Array<(err?: Error | null) => void> = [];

  constructor(private readonly sendPing = true) {
    super();
  }

  ping(callback: (err?: Error | null) => void): boolean {
    this.pingCalls += 1;
    if (!this.sendPing) return false;
    this.pingCallbacks.push(callback);
    return true;
  }

  acknowledgePings(): void {
    for (const callback of this.pingCallbacks.splice(0)) callback(null);
  }

  close(): void {
    this.closeCalls += 1;
    this.closed = true;
    this.emit("close");
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

let pool: H2PoolInstance | undefined;

afterEach(() => {
  pool?.closeAll();
  pool = undefined;
  establishH2Mock.mockReset();
});

describe("ENG-3017: concurrent idle H2 validation", () => {
  it("shares one ping across concurrent callers", async () => {
    let now = 1_000;
    const session = new PingSession();
    pool = new H2Pool({ maxIdleMs: 5, pingTimeoutMs: 10_000, now: () => now });
    establishH2Mock.mockResolvedValue(session as unknown as http2.ClientHttp2Session);

    await pool.get(DOMAIN);
    now += 10;

    const requests = Array.from({ length: 100 }, () => pool!.get(DOMAIN));
    await tick();
    session.acknowledgePings();
    const sessions = await Promise.all(requests);

    expect(session.pingCalls).toBe(1);
    expect(session.closeCalls).toBe(0);
    expect(sessions.every((value) => value === (session as unknown))).toBe(true);
  });

  it("does not evict a healthy session when Node does not send the ping", async () => {
    let now = 1_000;
    const session = new PingSession(false);
    pool = new H2Pool({ maxIdleMs: 5, now: () => now });
    establishH2Mock.mockResolvedValue(session as unknown as http2.ClientHttp2Session);

    await pool.get(DOMAIN);
    now += 10;

    const result = await pool.get(DOMAIN);

    expect(result).toBe(session);
    expect(session.closeCalls).toBe(0);
  });
});
