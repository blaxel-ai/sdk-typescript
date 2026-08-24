import { describe, expect, it } from "vitest";
import { safeCallback, safeCallbackAsync } from "../../@blaxel/core/src/common/callbacks.js";
import { SandboxProcess } from "../../@blaxel/core/src/sandbox/process/process.js";
import type { SandboxConfiguration } from "../../@blaxel/core/src/sandbox/types.js";

/**
 * A caller's callback is caller code and can throw for reasons unrelated to the
 * transport. It used to escape the read loop, get caught as a stream failure,
 * and end the stream for good while the sandbox process kept running and
 * producing output nobody received.
 */

function streamOf(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(line + "\n"));
      controller.close();
    },
  });
  return { status: 200, body } as unknown as Response;
}

/** A SandboxProcess whose transport is a canned stream instead of the network. */
function processServing(lines: string[]): SandboxProcess {
  const sandbox = {
    metadata: { name: "test-sandbox" },
    forceUrl: "http://sandbox.test",
    headers: {},
  } as unknown as SandboxConfiguration;
  const proc = new SandboxProcess(sandbox);
  (proc as unknown as { h2Fetch: () => Promise<Response> }).h2Fetch = () =>
    Promise.resolve(streamOf(lines));
  return proc;
}

describe("streamLogs callback isolation", () => {
  it("keeps streaming after a callback throws", async () => {
    const received: string[] = [];
    const errors: string[] = [];

    const control = processServing([
      '{"tick":1}',
      "not-json-at-all", // a client parsing every line blows up here
      '{"tick":2}',
      '{"tick":3}',
    ]).streamLogs("187", {
      onLog: (line) => {
        JSON.parse(line); // what a protocol client does
        received.push(line);
      },
      onError: (e) => errors.push(e.message),
    });

    await control.wait();

    // The lines after the bad one must still arrive.
    expect(received).toEqual(['{"tick":1}', '{"tick":2}', '{"tick":3}']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/JSON/i);
  });

  it("reports every failing line without dropping the good ones", async () => {
    const received: string[] = [];
    const errors: string[] = [];

    const control = processServing(["bad", "good", "bad", "good"]).streamLogs("187", {
      onLog: (line) => {
        if (line === "bad") throw new Error("boom");
        received.push(line);
      },
      onError: (e) => errors.push(e.message),
    });

    await control.wait();

    expect(received).toEqual(["good", "good"]);
    expect(errors).toEqual(["boom", "boom"]);
  });

  it("still filters the server's internal keepalive marker", async () => {
    const received: string[] = [];

    const control = processServing(['{"tick":1}', "[keepalive]", '{"tick":2}']).streamLogs("187", {
      onLog: (line) => received.push(line),
    });

    await control.wait();

    expect(received).toEqual(['{"tick":1}', '{"tick":2}']);
  });
});

describe("safeCallback", () => {
  it("swallows nothing when an onError is given", () => {
    const errors: string[] = [];
    safeCallback(() => { throw new Error("sync boom"); }, "x", (e) => errors.push(e.message));
    expect(errors).toEqual(["sync boom"]);
  });

  it("reports a rejected promise from a sync-looking callback", async () => {
    const errors: string[] = [];
    safeCallback(() => Promise.reject(new Error("async boom")), "x", (e) => errors.push(e.message));
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual(["async boom"]);
  });

  it("survives an onError that throws", () => {
    expect(() =>
      safeCallback(() => { throw new Error("boom"); }, "x", () => { throw new Error("handler boom"); }),
    ).not.toThrow();
  });

  it("is a no-op without a callback", () => {
    expect(() => safeCallback(undefined, "x", () => { throw new Error("never"); })).not.toThrow();
  });

  it("awaits async callbacks and reports rejections", async () => {
    const errors: string[] = [];
    const order: string[] = [];
    await safeCallbackAsync(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("callback");
    }, "x", (e) => errors.push(e.message));
    order.push("after");
    expect(order).toEqual(["callback", "after"]);

    await safeCallbackAsync(() => Promise.reject(new Error("rejected")), "x", (e) => errors.push(e.message));
    expect(errors).toEqual(["rejected"]);
  });
});
