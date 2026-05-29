// Harness: _h2Send state-machine ordering
//
// Locks the event-ordering guarantees of the `_h2Send` state machine
// (h2fetch.ts:286-440) against the real `createH2Fetch` transport over real
// fault-harness sessions:
//   - abort BEFORE response  -> pre-flight/early reject with AbortError, no hang
//     (h2fetch.ts:350-379).
//   - abort DURING streaming -> the response body stream errors with AbortError
//     once headers have arrived and the body stream is still open
//     (h2fetch.ts:362-366), no unhandled rejection.
//   - GOAWAY/RST racing 200s across concurrent streams on ONE session -> per-stream
//     isolation: the 200s resolve, the RST'd ones reject; one bad stream does not
//     kill its siblings (the per-stream `req.on("error")` at h2fetch.ts:412/426).
//   - listener hygiene -> after many sequential requests on one session, the
//     session's close/goaway/error listener counts return to baseline (no
//     per-request leak), tying to ensureH2SessionListenerBudget (h2fetch.ts:442-450).
//
// Determinism: real timers are used only for the bounded streaming-hold window
// (<=120ms) and the slow-response overlap; control is otherwise event-driven.
import http2 from "http2";
import { afterEach, describe, expect, it } from "vitest";
import { createH2Fetch } from "../../../@blaxel/core/src/common/h2fetch.js";
import { startH2FaultServer, type H2FaultServer } from "./h2-fault-server.js";

let server: H2FaultServer | undefined;
let session: http2.ClientHttp2Session | undefined;

afterEach(async () => {
  if (session && !session.destroyed) session.destroy();
  session = undefined;
  if (server) await server.close();
  server = undefined;
});

async function connect(cmd?: Parameters<typeof startH2FaultServer>[0]): Promise<void> {
  server = await startH2FaultServer(cmd);
  session = server.connectClient();
  await new Promise<void>((resolve) => session!.once("connect", () => resolve()));
}

/** Read a ReadableStream to completion, returning the decoded text. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

describe("_h2Send protocol-race ordering", () => {
  it("abort BEFORE response: an already-aborted signal rejects with AbortError and hangs nothing", async () => {
    await connect();
    const h2fetch = createH2Fetch(session!);

    const controller = new AbortController();
    controller.abort();

    let caught: Error | undefined;
    try {
      await h2fetch(
        new Request(`${server!.url}/pre-abort`, { signal: controller.signal }),
      );
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.name).toBe("AbortError");
  });

  it("abort DURING streaming: the response body stream errors with AbortError, no unhandled rejection", async () => {
    // Server sends headers + 'chunk-1' immediately, then holds the response open.
    await connect({ command: { respondThenHoldBodyMs: 120 } });
    const h2fetch = createH2Fetch(session!);

    const controller = new AbortController();
    const res = await h2fetch(
      new Request(`${server!.url}/stream`, { signal: controller.signal }),
    );
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // First chunk arrives; the body stream is open.
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decoder.decode(first.value)).toBe("chunk-1");

    // Abort while the body stream is still open -> the stream errors.
    controller.abort();

    let streamError: Error | undefined;
    try {
      await reader.read();
    } catch (err) {
      streamError = err as Error;
    }
    expect(streamError).toBeDefined();
    expect(streamError!.name).toBe("AbortError");
  });

  it("GOAWAY/RST racing 200s on ONE session: siblings are isolated (200s resolve, RST'd reject)", async () => {
    // RST only the /bad-* paths; every other path gets a baseline 200 echo. All
    // requests share ONE session, so this proves a per-stream RST does not kill
    // the sibling streams.
    await connect({
      command: {
        rstStreamWith: {
          code: http2.constants.NGHTTP2_ENHANCE_YOUR_CALM,
          forPaths: ["/bad-0", "/bad-1"],
        },
      },
    });
    const h2fetch = createH2Fetch(session!);

    const goodPaths = ["/good-0", "/good-1", "/good-2"];
    const badPaths = ["/bad-0", "/bad-1"];

    const settled = await Promise.allSettled(
      [...goodPaths, ...badPaths].map((p) =>
        h2fetch(new Request(`${server!.url}${p}`)).then(async (r) => {
          // Drain the body so the stream completes cleanly.
          await r.text();
          return r.status;
        }),
      ),
    );

    const byPath = new Map(
      [...goodPaths, ...badPaths].map((p, i) => [p, settled[i]]),
    );

    for (const p of goodPaths) {
      const r = byPath.get(p)!;
      expect(r.status).toBe("fulfilled");
      expect((r as PromiseFulfilledResult<number>).value).toBe(200);
    }
    for (const p of badPaths) {
      const r = byPath.get(p)!;
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason).toMatchObject({
        code: "ERR_HTTP2_STREAM_ERROR",
      });
    }

    // The session itself survived the RST'd streams and stays usable.
    expect(session!.closed).toBe(false);
    expect(session!.destroyed).toBe(false);
  });

  it("listener hygiene: per-request close/goaway/error listeners return to baseline after N requests", async () => {
    await connect();

    // Baseline AFTER connect: the harness's connectClient() installs one
    // `error` and one `close` listener of its own, so the floor is not zero.
    const baseline = {
      close: session!.listenerCount("close"),
      goaway: session!.listenerCount("goaway"),
      error: session!.listenerCount("error"),
    };

    const h2fetch = createH2Fetch(session!);
    const N = 40;
    for (let i = 0; i < N; i++) {
      const res = await h2fetch(new Request(`${server!.url}/n${i}`));
      // Fully consume the body so the per-request listeners are torn down.
      await readAll(res.body!);
    }

    // No per-request leak: counts are back at the post-connect baseline.
    expect(session!.listenerCount("close")).toBe(baseline.close);
    expect(session!.listenerCount("goaway")).toBe(baseline.goaway);
    expect(session!.listenerCount("error")).toBe(baseline.error);

    // The listener budget was raised once for the session (h2fetch.ts:442-450),
    // so the per-request adds never tripped MaxListenersExceededWarning.
    expect(session!.getMaxListeners()).toBeGreaterThanOrEqual(64);
  });
});
