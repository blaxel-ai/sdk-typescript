// Transparent re-send of a request the peer REFUSED.
//
// A pooled H2 session can be drained by the peer at any moment (an edge
// recycling the connection, a rolling gateway deploy, a route moving). The drain
// sends GOAWAY, and every stream above its `lastStreamID` is refused outright:
// RFC 9113 §6.8 guarantees the peer did not and will not process it. Before this
// behavior the SDK surfaced "HTTP/2 session sent GOAWAY before response" for
// those requests, and only IDEMPOTENT operations recovered (via
// retryOnTransientReset) — a POST such as process.exec failed outright even
// though nothing had reached origin.
//
// The gateway (`h2GatewayRequest`) now re-sends a provably-refused request ONCE
// on a fresh session, for ANY method. These tests drive the real pool-backed
// transport against the fault harness and pin every side of that contract:
//   - refused stream            -> re-sent, the caller only sees the 200,
//   - non-idempotent POST       -> also re-sent, body replayed intact,
//   - GOAWAY covering our stream (peer may have processed it) -> NOT re-sent,
//   - peer keeps draining       -> bounded at one re-send, then the error.
import type http2 from "http2";
import { afterEach, describe, expect, it } from "vitest";
import { createPoolBackedH2Fetch } from "../../../@blaxel/core/src/common/h2fetch.js";
import { H2Pool } from "../../../@blaxel/core/src/common/h2pool.js";
import { startH2FaultServer, type H2FaultServer } from "./h2-fault-server.js";

const DOMAIN = "edge.goaway.example.com";

type EstablishHook = {
  _establish: (domain: string) => Promise<http2.ClientHttp2Session>;
};

let server: H2FaultServer | undefined;
let pool: H2Pool | undefined;

afterEach(async () => {
  if (pool) pool.closeAll();
  pool = undefined;
  if (server) await server.close();
  server = undefined;
});

/**
 * Pool-backed fetch pointed at the fault server. Every `pool.get()` miss
 * establishes a real client session against the harness, so a re-send after the
 * drained session is evicted genuinely runs over a NEW connection.
 */
function poolBackedFetch(): (input: Request) => Promise<Response> {
  pool = new H2Pool();
  (pool as unknown as EstablishHook)._establish = () =>
    Promise.resolve(server!.connectClient());
  return createPoolBackedH2Fetch(pool, DOMAIN);
}

/**
 * A real drain never refuses the first stream of a connection (and Node's
 * `goaway()` cannot express it — see `goawayRefusingStreams`), so every scenario
 * warms the pooled session with one served request first.
 */
async function warmSession(h2fetch: (input: Request) => Promise<Response>): Promise<void> {
  const warm = await h2fetch(new Request(`${server!.url}/warm`));
  expect(warm.status).toBe(200);
  // Drain the body: an unread response stream keeps its H2 stream open, which
  // would stall the harness shutdown in afterEach.
  await warm.text();
}

describe("GOAWAY refusing a stream: transparent re-send", () => {
  it("re-sends on a fresh session when the peer refused the request", async () => {
    server = await startH2FaultServer({ command: { goawayRefusingStreams: [2] } });
    const h2fetch = poolBackedFetch();
    await warmSession(h2fetch);

    const response = await h2fetch(new Request(`${server.url}/read`));

    expect(response.status).toBe(200);
    await response.text();
    // The refused stream and its re-send both reached the server; the caller
    // never saw the drain.
    expect(server.requests.map((r) => r.path)).toEqual(["/warm", "/read", "/read"]);
  });

  it("re-sends a non-idempotent POST with its body intact", async () => {
    server = await startH2FaultServer({ command: { goawayRefusingStreams: [2] } });
    const h2fetch = poolBackedFetch();
    await warmSession(h2fetch);

    const response = await h2fetch(
      new Request(`${server.url}/process`, { method: "POST", body: "run-me" }),
    );

    // The harness echoes the request body, proving the memoized bytes were
    // replayed on the second attempt rather than sent empty.
    expect(await response.text()).toBe("run-me");
    expect(
      server.requests.filter((r) => r.method === "POST").map((r) => r.body),
    ).toEqual(["run-me", "run-me"]);
  });

  it("does NOT re-send when the GOAWAY covers our stream (peer may have processed it)", async () => {
    server = await startH2FaultServer({ command: { goawayIncludingStreams: [2] } });
    const h2fetch = poolBackedFetch();
    await warmSession(h2fetch);

    await expect(
      h2fetch(new Request(`${server.url}/process`, { method: "POST", body: "run-me" })),
    ).rejects.toThrow(/GOAWAY|closed before response/);

    // The POST reached the server exactly once: re-sending an ambiguous request
    // could duplicate the side effect.
    expect(server.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("surfaces the error after a single re-send when the peer keeps draining", async () => {
    // Ordinal 2 is refused (triggering the re-send); ordinal 3 is the re-send,
    // the first stream of its fresh session, which the peer also GOAWAYs.
    server = await startH2FaultServer({
      command: { goawayRefusingStreams: [2], goawayIncludingStreams: [3] },
    });
    const h2fetch = poolBackedFetch();
    await warmSession(h2fetch);

    await expect(h2fetch(new Request(`${server.url}/read`))).rejects.toThrow(
      /GOAWAY|REFUSED|closed before response|ERR_HTTP2/,
    );

    // Bounded: the original attempt plus one re-send, never an unbounded loop.
    expect(server.requests.filter((r) => r.path === "/read")).toHaveLength(2);
  });
});
