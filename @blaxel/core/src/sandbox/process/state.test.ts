import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../common/env.js", () => ({ env: process.env }));
import { observeProcess, ProcessObservationError } from "./state.js";
import type { ProcessResponse } from "../client/index.js";

const observation = (status: ProcessResponse["status"] = "running"): ProcessResponse => ({
  status, command: "sleep 2", completedAt: "", exitCode: 0, logs: "", name: "original", pid: "123",
  startedAt: "", stderr: "", stdout: "", workingDir: "/",
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("process observation", () => {
  it.each(["completed", "failed", "killed", "stopped"] as const)("returns only confirmed terminal %s without another read", async status => {
    const result = observation(status); const read = vi.fn().mockResolvedValue(result);
    expect(await observeProcess("original", read)).toBe(result);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 404])("preserves last running observation and propagates HTTP %s", async status => {
    const running = observation(); const cause = Object.assign(new Error("status unavailable"), { status });
    const read = vi.fn().mockResolvedValueOnce(running).mockRejectedValue(cause);
    await expect(observeProcess("original", read, { interval: 1 })).rejects.toMatchObject({ identifier: "original", reason: "status", lastObservation: running, cause });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it.each([408, 429, 500, 502, 503, 504])("recovers after HTTP %s without restarting", async status => {
    vi.useFakeTimers(); const completed = observation("completed");
    const read = vi.fn().mockRejectedValueOnce({ response: { status } }).mockResolvedValue(completed);
    const waiting = observeProcess("original", read);
    await vi.advanceTimersByTimeAsync(200);
    expect(await waiting).toBe(completed); expect(read).toHaveBeenCalledTimes(2);
  });
  it("recovers after a transport reset", async () => {
    vi.useFakeTimers(); const read = vi.fn().mockRejectedValueOnce(Object.assign(new Error("reset"), { code: "ECONNRESET" })).mockResolvedValue(observation("completed"));
    const waiting = observeProcess("original", read); await vi.advanceTimersByTimeAsync(200);
    expect((await waiting).status).toBe("completed");
  });
  it("bounds an unresponsive GET and aborts its transport", async () => {
    vi.useFakeTimers(); let requestSignal: AbortSignal | undefined;
    const waiting = observeProcess("original", signal => { requestSignal = signal; return new Promise(() => {}); }, { maxWait: 25 });
    const assertion = expect(waiting).rejects.toMatchObject({ reason: "timeout", identifier: "original" });
    await vi.advanceTimersByTimeAsync(25); await assertion; expect(requestSignal?.aborted).toBe(true);
  });
  it("keeps the last transient failure when its retry budget expires", async () => {
    vi.useFakeTimers(); const cause = Object.assign(new Error("network"), { code: "ECONNRESET" });
    const waiting = observeProcess("original", vi.fn().mockRejectedValue(cause), { maxWait: 10 });
    const assertion = expect(waiting).rejects.toMatchObject({ reason: "timeout", cause });
    await vi.advanceTimersByTimeAsync(10); await assertion;
  });
  it("cancels observation and preserves the last response", async () => {
    const controller = new AbortController(); const running = observation();
    const read = vi.fn().mockImplementation(() => { queueMicrotask(() => controller.abort("caller stopped waiting")); return Promise.resolve(running); });
    await expect(observeProcess("original", read, { signal: controller.signal })).rejects.toMatchObject({ reason: "cancelled", cause: "caller stopped waiting" });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("rejects unknown and malformed states instead of treating them as completion", async () => {
    await expect(observeProcess("original", vi.fn().mockResolvedValue({ status: "future-state" }))).rejects.toBeInstanceOf(ProcessObservationError);
    await expect(observeProcess("original", vi.fn().mockRejectedValue(new SyntaxError("invalid JSON")))).rejects.toMatchObject({ reason: "status" });
  });
  it("retains a just-received response when the deadline has elapsed", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(30);
    const completed = observation("completed");
    await expect(observeProcess("original", vi.fn().mockResolvedValue(completed), { maxWait: 25 })).rejects.toMatchObject({ reason: "timeout", lastObservation: completed });
  });
  it("includes the stop request in the same deadline", async () => {
    vi.useFakeTimers(); const read = vi.fn(); const stop = vi.fn(() => new Promise(() => {}));
    const waiting = observeProcess("original", read, { maxWait: 20 }, stop);
    const assertion = expect(waiting).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(20); await assertion;
    expect(stop).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled();
  });
});
