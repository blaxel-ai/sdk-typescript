// Regression: PM-2160
//
// PM-2160 / commit d6f0745: active H2 requests could exit the Node process early.
// Every pooled session is `markH2SessionIdleUnref`'d at h2warm.ts:55 so an idle
// session does not keep the event loop alive — but that left the socket unref'd
// even WHILE a request was in flight, so Node would exit before the response
// arrived. The fix (h2ref.ts) re-`ref()`s the session for the duration of an
// active request and `unref()`s it again once the request completes, with exact
// refcounting across concurrent requests on the same session.
//
// This pins those EXACT semantics against the real `createH2Fetch` transport +
// `h2ref.ts` over a real harness session that has been `markH2SessionIdleUnref`'d,
// spying on `session.ref` / `session.unref`.
//
// Empirically verified semantics (encoded below):
//   - markH2SessionIdleUnref on an idle (0 active) session -> unref() immediately.
//   - first active request 0->1 -> exactly one ref(); request fully drained -> unref().
//   - two concurrent requests -> ref() once on 0->1; unref() once only after BOTH
//     complete (refcount back to 0) — never in between.
//   - releasing the same active-request ref twice does not over-unref (the
//     release closure is idempotent; h2ref.ts:22-36).
//   - refH2SessionForActiveRequest is a no-op for a session that was never
//     idle-unref'd (h2ref.ts:16).
import http2 from "http2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createH2Fetch } from "../../../@blaxel/core/src/common/h2fetch.js";
import {
  markH2SessionIdleUnref,
  refH2SessionForActiveRequest,
} from "../../../@blaxel/core/src/common/h2ref.js";
import {
  startH2FaultServer,
  type H2FaultServer,
} from "../fault-injection/h2-fault-server.js";

let server: H2FaultServer | undefined;
let session: http2.ClientHttp2Session | undefined;

afterEach(async () => {
  if (session && !session.destroyed) session.destroy();
  session = undefined;
  if (server) await server.close();
  server = undefined;
  vi.restoreAllMocks();
});

async function connect(cmd?: Parameters<typeof startH2FaultServer>[0]): Promise<void> {
  server = await startH2FaultServer(cmd);
  session = server.connectClient();
  await new Promise<void>((resolve) => session!.once("connect", () => resolve()));
}

describe("PM-2160: active H2 requests ref the session; idle ones stay unref'd", () => {
  it("single request: idle-unref'd, then ref() on active, then unref() after the body is fully consumed", async () => {
    await connect();
    const refSpy = vi.spyOn(session!, "ref");
    const unrefSpy = vi.spyOn(session!, "unref");

    // Idle and unref'd: marking unrefs immediately, with no ref() yet.
    markH2SessionIdleUnref(session!);
    expect(refSpy).toHaveBeenCalledTimes(0);
    expect(unrefSpy).toHaveBeenCalledTimes(1);

    const h2fetch = createH2Fetch(session!);
    const res = await h2fetch(
      new Request(`${server!.url}/x`, { method: "POST", body: "hello" }),
    );

    // Request is active: exactly one ref() on the 0->1 transition, no extra unref yet.
    expect(refSpy).toHaveBeenCalledTimes(1);
    expect(unrefSpy).toHaveBeenCalledTimes(1);

    // Draining the body to end completes the request and returns to idle: unref().
    await expect(res.text()).resolves.toBe("hello");
    expect(refSpy).toHaveBeenCalledTimes(1);
    expect(unrefSpy).toHaveBeenCalledTimes(2);
  });

  it("two concurrent requests: ref() once on 0->1; unref() only after BOTH complete", async () => {
    // Hold both responses briefly so the two requests overlap as active.
    await connect({ command: { delayResponseMs: 60 } });
    const refSpy = vi.spyOn(session!, "ref");
    const unrefSpy = vi.spyOn(session!, "unref");

    markH2SessionIdleUnref(session!);
    const unrefAfterMark = unrefSpy.mock.calls.length; // 1 (idle unref)
    expect(unrefAfterMark).toBe(1);

    const h2fetch = createH2Fetch(session!);
    const p1 = h2fetch(new Request(`${server!.url}/a`, { method: "POST", body: "1" }))
      .then((r) => r.text());
    const p2 = h2fetch(new Request(`${server!.url}/b`, { method: "POST", body: "2" }))
      .then((r) => r.text());

    // Wait until both streams are open and active (both ref-counted).
    await vi.waitFor(() => {
      expect(refSpy.mock.calls.length).toBe(1);
    });
    // While both are in flight: ref() exactly once (0->1), and NO unref beyond
    // the idle-mark one (refcount has not returned to 0).
    expect(refSpy).toHaveBeenCalledTimes(1);
    expect(unrefSpy.mock.calls.length - unrefAfterMark).toBe(0);

    await expect(Promise.all([p1, p2])).resolves.toEqual(["1", "2"]);

    // Both complete -> refcount back to 0 -> exactly one unref() for the pair.
    expect(refSpy).toHaveBeenCalledTimes(1);
    expect(unrefSpy.mock.calls.length - unrefAfterMark).toBe(1);
  });

  it("idempotency: releasing the same active-request ref twice does not over-unref (h2ref.ts:22-36)", async () => {
    await connect();
    markH2SessionIdleUnref(session!);
    const unrefSpy = vi.spyOn(session!, "unref");

    const release = refH2SessionForActiveRequest(session!);
    release();
    expect(unrefSpy).toHaveBeenCalledTimes(1);
    // Second release is a no-op: the closure guards with `released` (h2ref.ts:25).
    release();
    expect(unrefSpy).toHaveBeenCalledTimes(1);
  });

  it("no-op for a session that was never idle-unref'd (h2ref.ts:16): neither ref() nor unref()", async () => {
    await connect();
    const refSpy = vi.spyOn(session!, "ref");
    const unrefSpy = vi.spyOn(session!, "unref");

    // Not marked idle-unref -> refH2SessionForActiveRequest returns a no-op.
    const release = refH2SessionForActiveRequest(session!);
    expect(refSpy).toHaveBeenCalledTimes(0);
    release();
    expect(unrefSpy).toHaveBeenCalledTimes(0);
  });
});
