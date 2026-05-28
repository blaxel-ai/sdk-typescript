// Regression: ENG-2340
//
// ENG-2340 was a silent timeout-retry that DUPLICATED a non-idempotent POST:
// a slow request would hit a 10s transport timeout, get retried, and the server
// would process it twice (e.g. "process already exists"). The fix removed the
// transport-level timeout-retry entirely (the transport never retries; that is
// now a caller concern — see the ENG-2342 doctrine).
//
// This test locks in today's behavior against the real `createH2Fetch`
// transport + a real H2 server: a slow POST to /process must produce EXACTLY
// ONE request/stream on the wire, and the client must resolve to that single
// response. If the transport ever silently retries a slow POST again, the
// recorded-request count would exceed 1 and this test fails.
//
// Determinism: the server delays its response by 200ms (real timer, kept tiny).
// The current transport has NO sub-2-minute timeout (its only safety timer is
// the 120s per-domain slot release, which does not cancel the request), so a
// 200ms delay is more than enough to prove no retry fires while staying fast.
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

describe("ENG-2340: transport never silently retries/duplicates a slow POST", () => {
  it("sends EXACTLY ONE request for a slow non-idempotent POST and resolves to its single response", async () => {
    // Model a slow non-idempotent POST: the server holds the response 200ms.
    server = await startH2FaultServer({ command: { delayResponseMs: 200 } });
    const session = server.connectClient();
    const h2fetch = createH2Fetch(session);

    const res = await h2fetch(
      new Request(`${server.url}/process`, {
        method: "POST",
        body: JSON.stringify({ name: "job-1" }),
        headers: { "content-type": "application/json" },
      }),
    );

    // The client resolves to the one and only response the server produced.
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe(JSON.stringify({ name: "job-1" }));

    // The crux: the server received the POST to /process exactly once. No
    // silent retry, no duplicate stream.
    const processRequests = server.requests.filter((r) => r.path === "/process");
    expect(processRequests).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
    expect(processRequests[0].method).toBe("POST");

    session.destroy();
  });
});
