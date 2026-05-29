# HTTP/2 Reliability Coverage Matrix

| Failure mode | Current protection | Current coverage | New coverage in this branch | Owner / next action |
| --- | --- | --- | --- | --- |
| Stale pooled H2 session reuse | `H2Pool` evicts on `close`, `error`, `goaway`, and idle ping failure | `tests/integration/common/h2fetch.test.ts` pool eviction tests | Covered by existing focused contract tests | SDK transport |
| Post-flight H2 stream failure after request creation | Reject the in-flight request. Do not retry non-idempotent work through fetch | `h2RequestDirect` post-flight rejection tests | Existing tests remain the guardrail | SDK transport |
| Active request `ref` / idle `unref` lifecycle | `h2ref` refs idle-unref sessions while a response body is active | Existing end and cancel tests | Added response-body error cleanup coverage | SDK transport |
| Unsupported request body in direct H2 path | Preflight fallback to `globalThis.fetch` before opening an H2 stream | Direct `FormData` fallback test | Added pooled direct fallback test that preserves the pooled session | SDK transport |
| User mitigation path | `BL_DISABLE_H2` / `settings.disableH2` bypasses H2 | No sandbox-action routing contract test | Added sandbox action test proving global fetch is used | SDK transport |
| Multipart upload part failure | Abort multipart upload and preserve the original part error | No local unit contract | Added abort-on-part-failure unit test | SDK filesystem |
| True multipart binary threshold | SDK threshold is `> 5MB` | Some integration test names used 1.2MB and 2MB payloads | Renamed below-threshold tests and added 6MB binary integration coverage | SDK filesystem |
| Live H2-on / H2-off high-risk SDK paths | Manual local verification only | Ad hoc targeted tests | Added `tests/manual/h2-reliability-matrix.mjs` for process streaming, port fetch, filesystem multipart, interpreter | SDK transport / sandbox |
| `waitForPorts` 502 at scale | Not yet classified as SDK, platform, proxy, or CloudFront | Hosted Integration Tests flake | Added `tests/manual/h2-waitforports-diagnostics.mjs` with per-sandbox H2-on/off results | Separate triage lane |
| Framework regressions through user paths | Hosted canaries in `bl-test` | OpenAI Agents SDK JS/Python scheduled jobs | Add `@blaxel/core` version override and Mastra stream canary in `bl-test` | Framework canaries |
