/**
 * @vitest-environment node
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageInstance } from "../image/image.js";
import { POLL_MAX_INTERVAL_MS, pollDelayMs } from "./polling.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pollDelayMs", () => {
  it("starts at the interval and grows to the cap", () => {
    for (const [attempt, target] of [[1, 3000], [2, 4500], [3, 6750], [20, POLL_MAX_INTERVAL_MS]]) {
      for (let i = 0; i < 50; i++) {
        const delay = pollDelayMs(attempt, 3000);
        expect(delay).toBeGreaterThanOrEqual(target / 2);
        expect(delay).toBeLessThanOrEqual(target);
      }
    }
  });

  it("jitters delays", () => {
    const delays = new Set(Array.from({ length: 20 }, () => pollDelayMs(5, 2000)));
    expect(delays.size).toBeGreaterThan(1);
  });

  it("keeps an interval above the cap and treats zero as no wait", () => {
    expect(pollDelayMs(10, 60_000)).toBeGreaterThanOrEqual(30_000);
    expect(pollDelayMs(10, 60_000)).toBeLessThanOrEqual(60_000);
    expect(pollDelayMs(3, 0)).toBe(0);
    expect(pollDelayMs(10_000, 2000)).toBeLessThanOrEqual(POLL_MAX_INTERVAL_MS);
  });
});

describe("image build wait", () => {
  it("backs off between status reads", async () => {
    const statuses = ["DEPLOYED", ...Array<string>(8).fill("BUILDING"), "DEPLOYED"];
    const image = ImageInstance.fromRegistry("python:3.12-slim");
    const internals = image as unknown as {
      _getSandboxStatus(name: string): Promise<string | null>;
      _waitForDeployment(name: string, timeout: number, pollInterval: number): Promise<string>;
    };
    vi.spyOn(internals, "_getSandboxStatus").mockImplementation(() => Promise.resolve(statuses.shift() ?? null));
    vi.spyOn(Math, "random").mockReturnValue(1);
    const sleeps: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((resolve: () => void, ms: number) => {
      sleeps.push(ms);
      resolve();
      return 0;
    }) as never);

    const wait = internals._waitForDeployment("build", 900_000, 3000);
    await expect(wait).resolves.toBe("DEPLOYED");

    expect(sleeps[0]).toBe(3000);
    expect(sleeps).toEqual([...sleeps].sort((a, b) => a - b));
    expect(sleeps[sleeps.length - 1]).toBe(POLL_MAX_INTERVAL_MS);
  });
});
