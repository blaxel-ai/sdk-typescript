// HTTP/2 flow-control + body-length suite
//
// This locks down the protocol-level details behind the Bun H2 freeze
// (see @blaxel/core/src/common/h2-runtime.ts):
//
//   Bun < 1.3.11 never sends a connection-level WINDOW_UPDATE, so the shared
//   pooled session freezes after exactly 65535 cumulative body bytes — the
//   default HTTP/2 connection receive window — and every request on it hangs
//   until the edge resets the streams (~330s).
//
// A correct client (Node) grows that window. `establishH2` in h2warm.ts does it
// explicitly via session.setLocalWindowSize(h2ConnectionWindowSize). These
// tests observe the window ON THE WIRE (a real node:http2 server reads the
// server-side session's connection send-window, i.e. the client's advertised
// receive window) and prove:
//   1. a default client advertises exactly 65535 (the number Bun never grows),
//   2. setLocalWindowSize raises it far above 65535 (the SDK's mitigation),
//   3. bodies spanning the 65535 boundary transfer byte-perfect and complete,
//   4. content-length framing is correct for every body length.
//
// Deterministic and loopback-only: a self-signed localhost cert (shared with the
// fault harness), 127.0.0.1, ephemeral port. No network, no creds.
import http2 from "http2";
import { afterEach, describe, expect, it } from "vitest";
import { createH2Fetch } from "../../../@blaxel/core/src/common/h2fetch.js";
import {
  getTestTlsCert,
  startH2FaultServer,
  type H2FaultServer,
} from "./h2-fault-server.js";

const DEFAULT_CONNECTION_WINDOW = 65535; // 2^16 - 1
const RAISED_WINDOW = 32 * 1024 * 1024; // what h2warm.ts advertises
const RAISED_STREAM_WINDOW = 16 * 1024 * 1024;

type RawH2Server = {
  url: string;
  latestServerSession: () => http2.ServerHttp2Session | undefined;
  close: () => Promise<void>;
};

/**
 * A minimal real HTTP/2 server that (a) exposes the most recently connected
 * server-side session so a test can read its connection-level send window
 * (`state.remoteWindowSize` = the client's advertised receive window), and
 * (b) serves a body of N ASCII bytes at `/big/<N>`.
 */
async function startRawH2Server(): Promise<RawH2Server> {
  const { cert, key } = getTestTlsCert();
  let latest: http2.ServerHttp2Session | undefined;

  const server = http2.createSecureServer({
    cert,
    key,
    ALPNProtocols: ["h2"],
    // Give the client plenty of room to SEND to us; irrelevant to the
    // connection receive window we are measuring, but keeps POST bodies flowing.
    settings: { initialWindowSize: RAISED_STREAM_WINDOW },
  });
  server.on("error", () => {});
  server.on("sessionError", () => {});
  server.on("session", (session) => {
    latest = session;
    session.on("error", () => {});
  });

  server.on("stream", (stream, headers) => {
    const path = String(headers[http2.constants.HTTP2_HEADER_PATH] ?? "/");
    const match = /^\/big\/(\d+)$/.exec(path);
    if (match) {
      const n = Number(match[1]);
      stream.respond({
        [http2.constants.HTTP2_HEADER_STATUS]: 200,
        "content-type": "application/octet-stream",
        "content-length": n,
      });
      stream.end(Buffer.alloc(n, 0x61)); // 'a' * n
      return;
    }
    stream.respond({ [http2.constants.HTTP2_HEADER_STATUS]: 200 });
    stream.end("ok");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("raw H2 server failed to bind");
  }

  return {
    url: `https://127.0.0.1:${addr.port}`,
    latestServerSession: () => latest,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as unknown as { closeIdleConnections?: () => void })
          .closeIdleConnections?.();
      }),
  };
}

function connectClient(
  url: string,
  opts: { localWindowSize?: number; streamWindowSize?: number } = {},
): Promise<http2.ClientHttp2Session> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(url, {
      rejectUnauthorized: false,
      ALPNProtocols: ["h2"],
      ...(opts.streamWindowSize
        ? { settings: { initialWindowSize: opts.streamWindowSize } }
        : {}),
    });
    session.on("error", reject);
    session.once("connect", () => {
      if (opts.localWindowSize) {
        (session as unknown as { setLocalWindowSize?: (n: number) => void })
          .setLocalWindowSize?.(opts.localWindowSize);
      }
      resolve(session);
    });
  });
}

/** Round-trip a ping so any frames sent before it are guaranteed processed. */
function pingRoundTrip(session: http2.ClientHttp2Session): Promise<void> {
  return new Promise((resolve) => session.ping(() => resolve()));
}

async function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

let rawServer: RawH2Server | undefined;
let faultServer: H2FaultServer | undefined;
const clientSessions: http2.ClientHttp2Session[] = [];

afterEach(async () => {
  for (const s of clientSessions) {
    if (!s.destroyed) s.destroy();
  }
  clientSessions.length = 0;
  if (rawServer) await rawServer.close();
  rawServer = undefined;
  if (faultServer) await faultServer.close();
  faultServer = undefined;
});

function track(session: http2.ClientHttp2Session): http2.ClientHttp2Session {
  clientSessions.push(session);
  return session;
}

describe("HTTP/2 connection-level flow-control window (the Bun 65535 freeze)", () => {
  it("a default client advertises exactly the 65535-byte window Bun never grows", async () => {
    rawServer = await startRawH2Server();
    const client = track(await connectClient(rawServer.url));
    await pingRoundTrip(client);

    const serverSession = await waitFor(() => rawServer!.latestServerSession());
    // The server's connection-level SEND window == the client's advertised
    // RECEIVE window. With no WINDOW_UPDATE from the client it sits at the
    // protocol default: 65535. This is precisely the ceiling a broken Bun is
    // stuck behind forever.
    expect(serverSession.state.remoteWindowSize).toBe(DEFAULT_CONNECTION_WINDOW);
  });

  it("setLocalWindowSize raises the connection window far above 65535 (the SDK's mitigation)", async () => {
    rawServer = await startRawH2Server();
    const client = track(
      await connectClient(rawServer.url, { localWindowSize: RAISED_WINDOW }),
    );
    // Flush the WINDOW_UPDATE emitted by setLocalWindowSize, then read.
    await pingRoundTrip(client);

    const serverSession = await waitFor(() => rawServer!.latestServerSession());
    const window = serverSession.state.remoteWindowSize ?? 0;
    expect(window).toBeGreaterThan(DEFAULT_CONNECTION_WINDOW);
    // Effectively the full raised window (allow slack for anything already
    // consumed by the ping round-trip).
    expect(window).toBeGreaterThan(RAISED_WINDOW - 1_000_000);
  });

  it("a body larger than 65535 bytes streams to completion on a raised-window session", async () => {
    rawServer = await startRawH2Server();
    const session = track(
      await connectClient(rawServer.url, {
        localWindowSize: RAISED_WINDOW,
        streamWindowSize: RAISED_STREAM_WINDOW,
      }),
    );
    const h2fetch = createH2Fetch(session);

    const size = 1024 * 1024; // 1MB, ~16x the frozen window
    const res = await h2fetch(new Request(`${rawServer.url}/big/${size}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(size));

    const body = await readAll(res.body!);
    expect(body.byteLength).toBe(size);
    // Every byte intact (no truncation at the window boundary).
    expect(body.every((b) => b === 0x61)).toBe(true);
  });

  it("a correct client drains a >65535 body even at the DEFAULT window (Node replenishes; Bun would not)", async () => {
    // The freeze is not about the window value per se — it is about never
    // replenishing it. A correct client at the default 65535 window still
    // completes because it emits WINDOW_UPDATE as it consumes. This is the
    // positive control that isolates the bug to Bun's missing WINDOW_UPDATE.
    rawServer = await startRawH2Server();
    const session = track(await connectClient(rawServer.url)); // no raise
    const h2fetch = createH2Fetch(session);

    const size = 512 * 1024; // 8x the window
    const res = await h2fetch(new Request(`${rawServer.url}/big/${size}`));
    const body = await readAll(res.body!);
    expect(body.byteLength).toBe(size);
  });
});

describe("HTTP/2 content-length framing across the 65535 boundary", () => {
  // Every request body length must be framed with an accurate content-length
  // and round-trip byte-for-byte. The boundary sizes (65534/65535/65536) are the
  // ones the Bun bug is sensitive to, so they are explicit here.
  const sizes = [1, 1024, 65534, 65535, 65536, 131072, 1024 * 1024];

  it.each(sizes)(
    "POST of %i bytes: content-length is exact and the body round-trips",
    async (size) => {
      faultServer = await startH2FaultServer();
      const session = track(
        faultServer.connectClient() as http2.ClientHttp2Session,
      );
      await new Promise<void>((resolve) =>
        session.once("connect", () => resolve()),
      );
      const h2fetch = createH2Fetch(session);

      const payload = "a".repeat(size);
      const res = await h2fetch(
        new Request(`${faultServer.url}/echo`, {
          method: "POST",
          body: payload,
        }),
      );
      expect(res.status).toBe(200);

      // The server recorded the request; assert the framed content-length.
      const recorded = faultServer.requests.at(-1)!;
      expect(recorded.headers["content-length"]).toBe(String(size));
      expect(recorded.body.length).toBe(size);

      // And the echoed response body matches what we sent, exactly.
      const echoed = await res.text();
      expect(echoed.length).toBe(size);
      expect(echoed).toBe(payload);
    },
  );

  it("a GET with no body sets no content-length and returns an empty body", async () => {
    faultServer = await startH2FaultServer();
    const session = track(
      faultServer.connectClient() as http2.ClientHttp2Session,
    );
    await new Promise<void>((resolve) =>
      session.once("connect", () => resolve()),
    );
    const h2fetch = createH2Fetch(session);

    const res = await h2fetch(new Request(`${faultServer.url}/empty`));
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("");

    const recorded = faultServer.requests.at(-1)!;
    expect(recorded.headers["content-length"]).toBeUndefined();
  });
});
