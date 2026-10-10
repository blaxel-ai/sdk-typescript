// Vitest asserts on method references (spies) and never calls them detached.
 
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../@blaxel/core/src/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../@blaxel/core/src/client/index.js")>();
  return { ...actual, createSandbox: vi.fn() };
});

import { createSandbox } from "../../@blaxel/core/src/client/index.js";
import { settings } from "../../@blaxel/core/src/common/settings.js";
import { DriveInstance } from "../../@blaxel/core/src/drive/index.js";
import { SandboxDrive } from "../../@blaxel/core/src/sandbox/drive/index.js";
import { SandboxInstance } from "../../@blaxel/core/src/sandbox/sandbox.js";

// Mocked latencies in virtual time (fake timers), so the result is exact and the same on every machine.
const SANDBOX_MS = 300, DRIVE_CREATE_MS = 200, MOUNT_MS = 100, LIST_MS = 50;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const REGION = "us-was-1";

describe("SandboxInstance.create mountDrives latency (mocked, virtual time)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const mounted: Record<string, unknown>[] = [];
    const drive = (name: string) => new DriveInstance({ metadata: { name }, spec: { region: REGION } });
    vi.mocked(createSandbox).mockReset().mockImplementation((async () => {
      await sleep(SANDBOX_MS);
      return { data: { metadata: { name: "sandbox" }, spec: { region: REGION, runtime: {} }, status: "DEPLOYED" }, response: { status: 200 }, request: {} };
    }) as never);
    vi.spyOn(settings, "disableH2", "get").mockReturnValue(true);
    vi.spyOn(DriveInstance, "create").mockImplementation(async c => { await sleep(DRIVE_CREATE_MS); return drive((c as { name: string }).name); });
    vi.spyOn(DriveInstance, "createIfNotExists").mockImplementation(async c => { await sleep(DRIVE_CREATE_MS); return drive((c as { name: string }).name); });
    vi.spyOn(SandboxDrive.prototype, "mount").mockImplementation(async request => {
      await sleep(MOUNT_MS);
      mounted.push({ drivePath: "/", readOnly: false, ...request });
      return { success: true };
    });
    vi.spyOn(SandboxDrive.prototype, "list").mockImplementation(async () => { await sleep(LIST_MS); return [...mounted] as never; });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function elapsed(count: number) {
    const mountDrives = Array.from({ length: count }, (_, i) => ({ create: { name: `d${i}` }, mountPath: `/mnt/d${i}` }));
    const start = Date.now();
    const created = SandboxInstance.create({ image: "blaxel/base-image:latest", region: REGION }, { mountDrives }).then(() => Date.now() - start);
    await vi.advanceTimersByTimeAsync(60_000);
    return created;
  }

  // Before: sandbox, then each drive, then each mount, one after another.
  const before = (n: number) => SANDBOX_MS + n * (DRIVE_CREATE_MS + MOUNT_MS) + LIST_MS;

  it.each([
    // Drives are created during the sandbox's 300 ms; mounts follow at once (all within the concurrency bound).
    [1, 450],
    [4, 450],
    // Past the bound of 5, the other 3 drives are created from 200 to 400 ms, then mounted from 400 to 500 ms.
    [8, 550],
  ])("%i drives: sandbox and drives are set up together", async (count, expected) => {
    const ms = await elapsed(count);
    if (process.env.LATENCY_REPORT) process.stdout.write(`drives=${count} elapsed=${ms}ms (sequential would be ${before(count)}ms)\n`);
    expect(ms).toBe(expected);
    expect(ms).toBeLessThan(before(count));
  });
});
