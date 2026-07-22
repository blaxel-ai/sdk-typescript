# HTTP/2 fault-injection harness

A deterministic, in-process, zero-network HTTP/2 fault-injection test harness
for the Blaxel TypeScript SDK transport. Part of Phase 0 of the H2 fortification
work (Linear ENG-2675 / ENG-2677; see `H2_FORTIFICATION_STRATEGY.md` §6.1, §6.2).

## What this is

`h2-fault-server.ts` is a controllable `node:http2` secure server (TLS + ALPN
`h2`) that binds to `127.0.0.1` on an ephemeral port. Tests connect a **real**
`ClientHttp2Session` to it and hand that session to `createH2Fetch()` from
`@blaxel/core/src/common/h2fetch.ts`, so they exercise the **actual** transport
state machine and session lifecycle against authentic HTTP/2 frames — not a mock.

The server can inject, per request:

- baseline echo `200` (returns method/path headers + body verbatim),
- `goawayAfterStreams: n` — GOAWAY the session after `n` streams,
- `rstStreamWith: { code }` — RST_STREAM with an nghttp2 code
  (`NGHTTP2_ENHANCE_YOUR_CALM = 11`, `NGHTTP2_REFUSED_STREAM`,
  `NGHTTP2_INTERNAL_ERROR`),
- `settings: { maxConcurrentStreams }` — advertise a stream cap (initial command
  only; ships in the server's first SETTINGS frame so the client queues excess),
- `delayResponseMs: n` — respond after a delay (models a slow POST),
- `destroySocketMid` — drop the connection mid-flight.

It also records every received request (`method`, `:path`, headers, body, 1-based
index) so a test can assert **exactly-once** delivery.

## Scope — read this before extending

This harness validates the **client's RESPONSE** to HTTP/2 faults: how the
transport state machine and session lifecycle react to GOAWAY, RST_STREAM,
ENHANCE_YOUR_CALM, SETTINGS backpressure, slow responses, and mid-flight socket
drops. That is its entire job.

It explicitly does **NOT**:

- **Contain Pingora's code.** It is a `node:http2` server, not the production
  edge proxy.
- **Reproduce the real rapid-reset TRIGGER.** The production ENHANCE_YOUR_CALM
  class is a server-side, burst-*rate* phenomenon in Pingora. This harness can
  only emit a single ENHANCE_YOUR_CALM frame and assert the client reacts
  correctly — it cannot prove any client-side concurrency cap *value* prevents
  the production failure.
- **Gate ENG-2620 / ENG-2621.** "Cap = N fixes the measured failure rate" is a
  live-matrix + ENG-2621 (server-side) concern. Do not let a green run here be
  read as closing the ENHANCE_YOUR_CALM class.
- **Cover non-Node runtimes.** H2 is Node-only in this SDK (Bun/Deno/browser
  fall back to `globalThis.fetch` via the `action.ts` gate). Those runtimes get
  **zero** coverage from this harness; their fallback behavior is asserted in
  `tests/runtime-environments/**`.

## Files

- `h2-fault-server.ts` — the controllable server + `startH2FaultServer()`.
  Also exports `getTestTlsCert()` so other loopback H2 tests can reuse the
  runtime-generated localhost cert.
- `h2-fault-server.test.ts` — harness self-test (baseline, GOAWAY, RST
  ENHANCE_YOUR_CALM, low `maxConcurrentStreams`).
- `h2-flow-control-length.test.ts` — connection-level flow-control + body-length
  suite for the Bun 65535 freeze. Observes the wire: a default client advertises
  exactly the 65535-byte connection window Bun never grows, `setLocalWindowSize`
  (what `h2warm.ts` does) raises it far above that, bodies spanning the boundary
  transfer byte-perfect, and content-length framing is exact at every length.
  The version gate itself is unit-tested in
  `@blaxel/core/src/common/h2-runtime.test.ts` (exhaustive Bun/Deno matrix), and
  the per-runtime behavior is asserted across real Bun/Deno versions in CI's
  `h2-runtime-version-matrix` job via `tests/runtime-environments/**`.
- `fixtures/localhost-cert.pem`, `fixtures/localhost-key.pem` — **test-only**
  self-signed cert for `CN=localhost` (`subjectAltName` DNS:localhost,
  IP:127.0.0.1). Clients connect with `rejectUnauthorized: false`. Not used
  anywhere outside these tests.
- `vitest.faultharness.config.ts` — isolated config (no `globalSetup`, no creds)
  to run just this suite + the regression corpus.

The regression corpus lives in `../regressions/`:

- `ENG-2340-no-silent-retry-dup.test.ts` — slow POST → exactly one request.
- `ENG-2342-transport-never-retries.test.ts` — post-flight error → reject, no
  retry.

## Running

No network and no `BL_API_KEY` are required.

```bash
npx vitest run \
  --config tests/integration/fault-injection/vitest.faultharness.config.ts \
  --reporter=verbose
```

These files are also matched by the root `vitest.config.ts` `tests/**/*.test.ts`
include, so they run in CI under the root config too.
