import { afterEach, describe, expect, it, vi } from "vitest";

const statsSymbol = Symbol.for("blaxel.h2stats");

function debugStats(): unknown {
  return (globalThis as unknown as Record<symbol, unknown>)[statsSymbol];
}

describe("BL_H2_DEBUG_STATS", () => {
  afterEach(() => {
    delete process.env.BL_H2_DEBUG_STATS;
    delete (globalThis as unknown as Record<symbol, unknown>)[statsSymbol];
    vi.resetModules();
  });

  it("does not expose transport statistics by default", async () => {
    await import("../../@blaxel/core/src/common/h2stats.js");

    expect(debugStats()).toBeUndefined();
  });

  it("exposes a current snapshot when enabled", async () => {
    process.env.BL_H2_DEBUG_STATS = "1";
    const { recordH2Fallback } = await import(
      "../../@blaxel/core/src/common/h2stats.js"
    );

    expect(debugStats()).toMatchObject({
      establishFailures: 0,
      fetchFallbacks: 0,
      byDomain: {},
    });

    recordH2Fallback("edge.example.com", "no-session");

    expect(debugStats()).toMatchObject({
      establishFailures: 0,
      fetchFallbacks: 1,
      fallbacksByReason: { "no-session": 1 },
      byDomain: {
        "edge.example.com": {
          fetchFallbacks: 1,
          fallbacksByReason: { "no-session": 1 },
        },
      },
    });
  });

  it("does not change transport behavior when the debug global rejects writes", async () => {
    process.env.BL_H2_DEBUG_STATS = "1";
    Object.defineProperty(globalThis, statsSymbol, {
      configurable: true,
      set: () => {
        throw new Error("global write rejected");
      },
    });
    const { recordH2Fallback } = await import(
      "../../@blaxel/core/src/common/h2stats.js"
    );

    expect(() => recordH2Fallback("edge.example.com", "no-session")).not.toThrow();
  });
});
