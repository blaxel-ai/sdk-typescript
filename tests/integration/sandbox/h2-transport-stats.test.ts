import type { SandboxInstance as Sandbox } from "@blaxel/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type DebugStats = {
  establishFailures: number;
  fetchFallbacks: number;
  fallbacksByReason: Record<string, number>;
  byDomain: Record<string, { fallbacksByReason: Record<string, number> }>;
};

const statsSymbol = Symbol.for("blaxel.h2stats");

function debugStats(): DebugStats {
  return (globalThis as unknown as Record<symbol, DebugStats>)[statsSymbol];
}

function domainFallbacks(stats: DebugStats, reason: string): number {
  return Object.values(stats.byDomain).reduce(
    (total, domain) => total + (domain.fallbacksByReason[reason] ?? 0),
    0,
  );
}

describe("H2 transport stats", () => {
  let sandboxName: string;
  let sandbox: Sandbox;

  beforeAll(async () => {
    process.env.BL_H2_DEBUG_STATS = "1";
    const [{ SandboxInstance }, helpers] = await Promise.all([
      import("@blaxel/core"),
      import("./helpers.js"),
    ]);
    const { defaultImage, defaultLabels, defaultRegion, uniqueName } = helpers;
    sandboxName = uniqueName("h2-stats");
    sandbox = await SandboxInstance.create({
      name: sandboxName,
      image: defaultImage,
      region: defaultRegion,
      memory: 2048,
      labels: defaultLabels,
    });
  });

  afterAll(async () => {
    const { SandboxInstance } = await import("@blaxel/core");
    await SandboxInstance.delete(sandboxName).catch(() => {});
    delete process.env.BL_H2_DEBUG_STATS;
    delete (globalThis as unknown as Record<symbol, unknown>)[statsSymbol];
  });

  it("counts a successful unsupported-body fallback through the sandbox API", async () => {
    const before = debugStats();

    await sandbox.fs.writeBinary("/tmp/h2-stats.bin", new Uint8Array([1, 2, 3]));
    const content = new Uint8Array(await (await sandbox.fs.readBinary("/tmp/h2-stats.bin")).arrayBuffer());

    expect(content).toEqual(new Uint8Array([1, 2, 3]));
    const after = debugStats();
    expect(after.fetchFallbacks - before.fetchFallbacks).toBe(1);
    expect(
      after.fallbacksByReason["unsupported-body"] -
        before.fallbacksByReason["unsupported-body"],
    ).toBe(1);
    expect(
      domainFallbacks(after, "unsupported-body") -
        domainFallbacks(before, "unsupported-body"),
    ).toBe(1);
  });
});
