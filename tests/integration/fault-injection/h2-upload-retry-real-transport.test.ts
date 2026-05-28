// Real-transport coverage for ENG-2680 upload retry.
//
// The unit tests (tests/unit/filesystem-part-retry.test.ts) classify SYNTHETIC
// error objects. That leaves one untested seam: does an error produced by an
// ACTUAL node:http2 RST_STREAM / GOAWAY / socket-drop carry the codes/markers the
// classifier matches? If it does not, the retry machinery is all green in unit
// tests yet never fires in production. These tests close that seam by driving the
// real `createH2Fetch` transport against the in-process H2 fault server, then:
//   1. asserting the real rejection is classified transient (retry WILL fire),
//   2. driving the real `retryOnTransient` loop over real faults (retry count +
//      self-heal when the fault clears),
//   3. confirming the classifier stays conservative (no over-retry).
// No creds, no network beyond loopback. See ./README.md for the harness scope.
import http2 from "http2";
import { afterEach, describe, expect, it } from "vitest";
import { createH2Fetch } from "../../../@blaxel/core/src/common/h2fetch.js";
import {
  isTransientUploadError,
  retryOnTransient,
} from "../../../@blaxel/core/src/sandbox/filesystem/filesystem.js";
import { settings } from "../../../@blaxel/core/src/common/settings.js";
import { startH2FaultServer, type H2FaultServer } from "./h2-fault-server.js";

const {
  NGHTTP2_ENHANCE_YOUR_CALM,
  NGHTTP2_REFUSED_STREAM,
  NGHTTP2_INTERNAL_ERROR,
} = http2.constants;

let server: H2FaultServer | undefined;
let session: http2.ClientHttp2Session | undefined;

afterEach(async () => {
  if (session && !session.destroyed) session.destroy();
  session = undefined;
  if (server) await server.close();
  server = undefined;
  delete settings.config.fsPartRetries;
});

// Drive one real fetch against `server` and return the rejection it produced
// (or undefined if it unexpectedly resolved).
async function captureFetchError(path: string): Promise<unknown> {
  const h2fetch = createH2Fetch(session!);
  try {
    await h2fetch(new Request(`${server!.url}${path}`));
    return undefined;
  } catch (err) {
    return err;
  }
}

describe("ENG-2680 real-transport: faults that should self-heal are classified transient", () => {
  it.each([
    ["RST_STREAM ENHANCE_YOUR_CALM", { rstStreamWith: { code: NGHTTP2_ENHANCE_YOUR_CALM } }],
    ["RST_STREAM REFUSED_STREAM", { rstStreamWith: { code: NGHTTP2_REFUSED_STREAM } }],
    ["RST_STREAM INTERNAL_ERROR", { rstStreamWith: { code: NGHTTP2_INTERNAL_ERROR } }],
    ["GOAWAY before response", { goawayAfterStreams: 1 }],
    ["socket destroyed mid-flight", { destroySocketMid: true }],
  ])("classifies a real %s error as transient (retry will fire)", async (_label, command) => {
    server = await startH2FaultServer({ command });
    session = server.connectClient();

    const err = await captureFetchError("/upload-part");

    expect(err).toBeDefined(); // the real transport rejected, as expected
    expect(isTransientUploadError(err)).toBe(true);
  });

  it("does NOT flag a clean real 200 response as an error (no spurious retry)", async () => {
    server = await startH2FaultServer();
    session = server.connectClient();
    const h2fetch = createH2Fetch(session);

    const res = await h2fetch(new Request(`${server.url}/ok`));
    expect(res.status).toBe(200); // resolved, nothing for retry to act on
    expect(server.requests).toHaveLength(1);
  });
});

describe("ENG-2680 real-transport: the actual retryOnTransient loop over real faults", () => {
  it("retries a persistent real transient fault the configured number of times, then surfaces it", async () => {
    settings.config.fsPartRetries = 2;
    server = await startH2FaultServer({
      command: { rstStreamWith: { code: NGHTTP2_ENHANCE_YOUR_CALM } },
    });
    session = server.connectClient();
    const h2fetch = createH2Fetch(session);

    await expect(
      retryOnTransient(() => h2fetch(new Request(`${server!.url}/part`))),
    ).rejects.toBeDefined();

    // 1 initial attempt + 2 retries = 3 real round-trips the server actually saw.
    expect(server.requests).toHaveLength(3);
  });

  it("self-heals once the real transient fault clears between attempts", async () => {
    settings.config.fsPartRetries = 3;
    server = await startH2FaultServer({
      command: { rstStreamWith: { code: NGHTTP2_ENHANCE_YOUR_CALM } },
    });
    session = server.connectClient();
    const srv = server;
    const h2fetch = createH2Fetch(session);

    // Clear the fault as soon as the first attempt has reached the server. The
    // retry backoff (>=200ms) leaves ample room, so attempt 2 sees the baseline
    // echo — no wall-clock guessing, the flip is gated on the recorded request.
    const clearAfterFirstHit = (async () => {
      while (srv.requests.length < 1) {
        await new Promise<void>((r) => setImmediate(r));
      }
      srv.command({}); // back to baseline 200 echo
    })();

    const res = await retryOnTransient(() => h2fetch(new Request(`${srv.url}/heal`)));
    await clearAfterFirstHit;

    expect(res.status).toBe(200); // the retry landed once the fault cleared
    expect(srv.requests.length).toBeGreaterThanOrEqual(2); // failed at least once first
  });
});

describe("ENG-2680: the classifier stays conservative (no over-retry)", () => {
  it("does NOT treat application errors or a bare 'fetch failed' as transient", () => {
    // An app-level 500 body, a generic fetch failure, and an ordinary 4xx must
    // never be retried — only transport-level resets qualify. This is the safety
    // boundary that keeps auto-retry from masking real server errors.
    expect(isTransientUploadError(new Error('{"error":"INTERNAL_ERROR: disk full"}'))).toBe(false);
    expect(isTransientUploadError(new Error("fetch failed"))).toBe(false);
    expect(isTransientUploadError(new Error("400 Bad Request: invalid part"))).toBe(false);
    expect(isTransientUploadError(undefined)).toBe(false);
    expect(isTransientUploadError(null)).toBe(false);
  });

  it("treats a transport reset wrapped under a generic message as transient", () => {
    // The real failure shape: "fetch failed" wrapping a cause carrying the code.
    const wrapped = Object.assign(new Error("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    expect(isTransientUploadError(wrapped)).toBe(true);
  });
});
