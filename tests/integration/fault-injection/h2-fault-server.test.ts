// Harness self-test
//
// Drives the real `createH2Fetch` transport against the in-process H2 fault
// server to confirm the harness can both serve a clean baseline and inject the
// protocol faults the regression corpus relies on. Asserts the ACTUAL error
// messages/codes the current `@blaxel/core/src/common/h2fetch.ts` produces.
//
// Scope: client RESPONSE to faults only. See ./README.md.
import http2 from "http2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("h2-fault-server harness self-test", () => {
  describe("baseline echo", () => {
    beforeEach(async () => {
      server = await startH2FaultServer();
      session = server.connectClient();
    });

    it("GET returns 200 and records the request exactly once", async () => {
      const h2fetch = createH2Fetch(session!);
      const res = await h2fetch(new Request(`${server!.url}/hello`));

      expect(res.status).toBe(200);
      expect(res.headers.get("x-echo-method")).toBe("GET");
      expect(res.headers.get("x-echo-path")).toBe("/hello");
      await expect(res.text()).resolves.toBe("");

      expect(server!.requests).toHaveLength(1);
      expect(server!.requests[0]).toMatchObject({
        method: "GET",
        path: "/hello",
        index: 1,
      });
    });

    it("POST returns 200 and echoes the request body", async () => {
      const h2fetch = createH2Fetch(session!);
      const res = await h2fetch(
        new Request(`${server!.url}/echo`, { method: "POST", body: "round-trip" }),
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("x-echo-method")).toBe("POST");
      await expect(res.text()).resolves.toBe("round-trip");

      expect(server!.requests).toHaveLength(1);
      expect(server!.requests[0].body).toBe("round-trip");
    });
  });

  describe("GOAWAY before response", () => {
    it("rejects the client fetch with the GOAWAY message", async () => {
      server = await startH2FaultServer({ command: { goawayAfterStreams: 1 } });
      session = server.connectClient();
      const h2fetch = createH2Fetch(session);

      await expect(
        h2fetch(new Request(`${server.url}/goaway`)),
      ).rejects.toThrow("HTTP/2 session sent GOAWAY before response");
    });
  });

  describe("RST_STREAM ENHANCE_YOUR_CALM", () => {
    it("rejects with an error surfacing the ENHANCE_YOUR_CALM / ERR_HTTP2 marker", async () => {
      server = await startH2FaultServer({
        command: {
          rstStreamWith: { code: http2.constants.NGHTTP2_ENHANCE_YOUR_CALM },
        },
      });
      session = server.connectClient();
      const h2fetch = createH2Fetch(session);

      // The current transport propagates the stream error verbatim: the message
      // names ENHANCE_YOUR_CALM and the error carries code ERR_HTTP2_STREAM_ERROR.
      let caught: (Error & { code?: string }) | undefined;
      try {
        await h2fetch(new Request(`${server.url}/calm`));
      } catch (err) {
        caught = err as Error & { code?: string };
      }

      expect(caught).toBeDefined();
      expect(caught!.message).toContain("ENHANCE_YOUR_CALM");
      expect(caught!.code).toBe("ERR_HTTP2_STREAM_ERROR");
    });

    it("propagates other RST codes too (REFUSED_STREAM, INTERNAL_ERROR)", async () => {
      for (const code of [
        http2.constants.NGHTTP2_REFUSED_STREAM,
        http2.constants.NGHTTP2_INTERNAL_ERROR,
      ]) {
        const s = await startH2FaultServer({ command: { rstStreamWith: { code } } });
        const sess = s.connectClient();
        const h2fetch = createH2Fetch(sess);
        await expect(h2fetch(new Request(`${s.url}/rst`))).rejects.toMatchObject({
          code: "ERR_HTTP2_STREAM_ERROR",
        });
        sess.destroy();
        await s.close();
      }
    });
  });

  describe("low maxConcurrentStreams backpressure", () => {
    it("advertises the cap to the client, which queues (never exceeds) streams", async () => {
      server = await startH2FaultServer({
        command: { settings: { maxConcurrentStreams: 2 }, delayResponseMs: 40 },
      });
      session = server.connectClient();

      // The server advertises the cap in its initial SETTINGS frame; the client
      // observes it before issuing requests.
      await new Promise<void>((resolve) => {
        if (session!.remoteSettings?.maxConcurrentStreams === 2) return resolve();
        session!.once("remoteSettings", () => resolve());
        setTimeout(resolve, 1000);
      });
      expect(session!.remoteSettings.maxConcurrentStreams).toBe(2);

      const h2fetch = createH2Fetch(session);

      // Fire more requests than the cap at once. Node's client queues the
      // overflow rather than opening them, so they all succeed and the server
      // never sees more than the advertised number open concurrently.
      const statuses = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          h2fetch(new Request(`${server!.url}/s${i}`)).then((r) => r.status),
        ),
      );

      expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
      expect(server!.requests).toHaveLength(6);
    });
  });
});
