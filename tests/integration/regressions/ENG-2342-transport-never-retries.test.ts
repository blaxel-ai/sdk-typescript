// Regression: ENG-2342
//
// Doctrine: once a request has been put on the wire (post-flight), the
// transport NEVER transparently retries. Any failure after `session.request()`
// succeeds — RST_STREAM, mid-flight socket drop, GOAWAY — propagates to the
// caller as a rejection. Retry/timeout policy is a caller concern.
//
// This pins that doctrine against the real `createH2Fetch` transport + a real
// H2 server: a post-flight stream error (RST_STREAM) must reject AND must NOT
// be followed by a second request/stream for the same path. (The pre-flight
// fallback to globalThis.fetch is a separate path, only taken when the session
// is already closed/destroyed at call time and nothing was sent — not exercised
// here.)
import http2 from "http2";
import { afterEach, describe, expect, it } from "vitest";
import { createH2Fetch } from "../../../@blaxel/core/src/common/h2fetch.js";
import {
  startH2FaultServer,
  type H2FaultServer,
} from "../fault-injection/h2-fault-server.js";

let server: H2FaultServer | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
});

describe("ENG-2342: transport never retries post-flight", () => {
  it("rejects on a post-flight RST_STREAM without sending a second request", async () => {
    server = await startH2FaultServer({
      command: {
        rstStreamWith: { code: http2.constants.NGHTTP2_INTERNAL_ERROR },
      },
    });
    const session = server.connectClient();
    const h2fetch = createH2Fetch(session);

    await expect(
      h2fetch(
        new Request(`${server.url}/process`, { method: "POST", body: "x" }),
      ),
    ).rejects.toMatchObject({ code: "ERR_HTTP2_STREAM_ERROR" });

    // Give any (erroneous) retry a chance to land before asserting.
    await new Promise((r) => setTimeout(r, 50));

    // The request reached the server exactly once and was NOT retried after the
    // stream error. This is the heart of the ENG-2342 doctrine.
    expect(server.requests).toHaveLength(1);
    expect(server.requests.filter((r) => r.path === "/process")).toHaveLength(1);

    session.destroy();
  });

  it("rejects when the socket is destroyed mid-flight, with no retry", async () => {
    server = await startH2FaultServer({ command: { destroySocketMid: true } });
    const session = server.connectClient();
    const h2fetch = createH2Fetch(session);

    // A mid-flight connection drop surfaces as a rejection (session close /
    // stream error), never a transparent retry.
    await expect(
      h2fetch(new Request(`${server.url}/process`, { method: "POST", body: "y" })),
    ).rejects.toThrow();

    await new Promise((r) => setTimeout(r, 50));
    expect(server.requests.filter((r) => r.path === "/process")).toHaveLength(1);

    session.destroy();
  });
});
