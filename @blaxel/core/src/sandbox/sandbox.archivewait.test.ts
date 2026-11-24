import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxInstance } from "./sandbox.js";
import type { Sandbox } from "../client/index.js";

// waitForArchiveStatus is private: reach it without a network call, the way archive() does.
const { waitForArchiveStatus } = SandboxInstance as unknown as {
  waitForArchiveStatus: (
    name: string,
    launched: Sandbox,
    target: string,
    pending: Set<string>,
    entry: string,
    action: string,
    options: { interval?: number; maxWait?: number },
  ) => Promise<SandboxInstance>;
};

const INTERVAL_MS = 2000;
const ENTRY_READS = 8;

describe("archive wait delays", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads at the first interval until the operation is seen pending, then backs off", async () => {
    const statuses = [...Array<string>(ENTRY_READS).fill("DEPLOYED"), ...Array<string>(6).fill("ARCHIVING"), "ARCHIVED"];
    vi.spyOn(SandboxInstance, "get").mockImplementation(
      () => Promise.resolve({ status: statuses.shift() } as unknown as SandboxInstance),
    );
    const delays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      fn();
      return 0;
    }) as unknown as typeof setTimeout);

    const result = await waitForArchiveStatus(
      "sbx",
      { status: "DEPLOYED" } as Sandbox,
      "ARCHIVED",
      new Set(["ARCHIVING"]),
      "DEPLOYED",
      "archive",
      { interval: INTERVAL_MS, maxWait: 600_000 },
    );

    expect(result.status).toBe("ARCHIVED");
    expect(Math.max(...delays.slice(0, ENTRY_READS + 1))).toBeLessThanOrEqual(INTERVAL_MS);
    expect(Math.max(...delays.slice(ENTRY_READS + 1))).toBeGreaterThan(INTERVAL_MS);
  });
});
