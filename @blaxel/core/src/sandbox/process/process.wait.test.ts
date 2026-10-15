import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../common/env.js", () => ({ env: process.env }));
import { SandboxProcess } from "./process.js";
import { ResponseError } from "../action.js";
import type { Sandbox } from "../../client/types.gen.js";

const api = () => new SandboxProcess({ metadata: { name: "local" }, spec: {}, forceUrl: "http://localhost", headers: {} } as Sandbox);
const response = (status: string) => new Response(JSON.stringify({ status, exitCode: status === "failed" ? 7 : 0 }), { headers: { "content-type": "application/json" } });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("process wait", () => {
  it.each(["completed", "failed", "killed", "stopped"])("returns terminal %s immediately", async status => {
    const fetch = vi.fn().mockResolvedValue(response(status));
    vi.stubGlobal("fetch", fetch);
    expect((await api().wait("original")).status).toBe(status);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404])("propagates HTTP %s instead of returning the previous running state", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response("running")).mockResolvedValue(new Response("{}", { status })));
    await expect(api().wait("original", { interval: 1 })).rejects.toBeInstanceOf(ResponseError);
  });

  it.each([408, 429, 500, 502, 503, 504])("recovers from HTTP %s", async status => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("{}", { status })).mockResolvedValue(response("completed"));
    vi.stubGlobal("fetch", fetch);
    expect((await api().wait("original", { interval: 1 })).status).toBe("completed");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("recovers from a lost connection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue(response("completed")));
    expect((await api().wait("original", { interval: 1 })).status).toBe("completed");
  });

  it("bounds a hung request and aborts its transport", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);
    const assertion = expect(api().wait("original", { maxWait: 25 })).rejects.toThrow("Process did not finish in time (original)");
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect((fetch.mock.calls[0] as unknown as [Request])[0].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the last network error as the timeout cause", async () => {
    vi.useFakeTimers();
    const cause = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(cause));
    const assertion = expect(api().wait("original", { maxWait: 25 })).rejects.toMatchObject({ cause });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });

  it("cancels while sleeping without another request or leaked timers", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(response("running"));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const assertion = expect(api().wait("original", { signal: controller.signal })).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(5);
    controller.abort(reason);
    await assertion;
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits indefinitely through transient failures and returns a terminal state", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockImplementation(() => Promise.resolve(response("running")));
    vi.stubGlobal("fetch", fetch);
    let settled = false;
    const waiting = api().wait("original", { maxWait: -1, interval: 60_000 });
    void waiting.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(1); // Only the next polling interval.
    fetch.mockImplementation(() => Promise.resolve(response("failed")));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await waiting).toMatchObject({ status: "failed", exitCode: 7 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an infinite wait with a hung request", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const assertion = expect(api().wait("original", { maxWait: -1, signal: controller.signal })).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(vi.getTimerCount()).toBe(0);
    controller.abort(reason);
    await assertion;
    expect((fetch.mock.calls[0] as unknown as [Request])[0].signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("still propagates permanent errors during an infinite wait", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    await expect(api().wait("original", { maxWait: -1 })).rejects.toBeInstanceOf(ResponseError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([-2, -0.5, Infinity, NaN])("rejects invalid maxWait %s", async maxWait => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(api().wait("original", { maxWait })).rejects.toBeInstanceOf(RangeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps zero as an immediate deadline", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(api().wait("original", { maxWait: 0 })).rejects.toThrow("did not finish in time");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an unknown state instead of claiming completion", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("unknown")));
    await expect(api().wait("original")).rejects.toThrow("Unknown process status");
  });

  it("rejects a late terminal response even before the timeout callback runs", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(30);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("completed")));
    await expect(api().wait("original", { maxWait: 25 })).rejects.toThrow("Process did not finish in time");
  });
});
