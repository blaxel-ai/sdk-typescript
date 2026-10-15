import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxProcess } from "./process.js";

describe("SandboxProcess.wait", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns immediately when the initial status is terminal", async () => {
    vi.useFakeTimers();
    const process = Object.create(SandboxProcess.prototype) as SandboxProcess;
    const completed = { status: "completed" } as Awaited<ReturnType<SandboxProcess["get"]>>;
    const get = vi.spyOn(process, "get").mockResolvedValue(completed);

    await expect(process.wait("process-id", { interval: 5000 })).resolves.toBe(completed);

    expect(get).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
