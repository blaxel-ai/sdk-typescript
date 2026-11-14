import { describe, expect, it } from "vitest";
import { buildLimitHint } from "../../@blaxel/core/src/image/image.js";

describe("image build limit hint", () => {
  const notRetryable = " (not retryable until usage drops or the quota is raised: https://docs.blaxel.ai/Security/Quotas)";

  it("says a full image storage quota is not retryable, old and new body", () => {
    const oldServer = JSON.stringify({
      error:
        "Image storage quota reached: 10/10 MiB used by images across your workspaces. Delete unused images before building again, or request additional quota at https://app.blaxel.ai/account/plan-quotas?id=acc",
      code: 429,
    });
    const newServer = JSON.stringify({ code: "QUOTA_EXCEEDED", message: "Image storage quota reached", status_code: 429 });
    expect(buildLimitHint(429, oldServer)).toBe(notRetryable);
    expect(buildLimitHint(429, newServer)).toBe(notRetryable);
  });

  it("leaves other answers alone and marks rate limits retryable", () => {
    expect(buildLimitHint(429, JSON.stringify({ error: "slow down", code: 429 }))).toBe("");
    expect(buildLimitHint(429, "<html>")).toBe("");
    expect(buildLimitHint(400, JSON.stringify({ code: "QUOTA_EXCEEDED" }))).toBe("");
    expect(buildLimitHint(429, JSON.stringify({ code: "RATE_LIMIT_EXCEEDED" }))).toBe(" (rate limited: retry with backoff)");
  });

  it("reads the build-backlog 429 as retryable, not a quota, though it links the plan quotas page", () => {
    const backlog =
      "Too many image builds are waiting for this account: 40 queued builds reserve 327680 MB of memory, 1310720 MB of scratch disk and 160 vCPUs, " +
      "and the queue holds at most five times your build quota. Retry once some builds finish, or upgrade your tier at https://app.blaxel.ai/account/plan-quotas?id=acc";
    expect(buildLimitHint(429, JSON.stringify({ error: backlog, code: 429 }))).toBe(
      " (the account's build queue is full: retry with backoff, once some builds finish)"
    );
    const named = JSON.stringify({ error: backlog, code: "BUILD_QUEUE_FULL", message: backlog, retryable: true });
    expect(buildLimitHint(429, named, new Headers({ "X-Should-Retry": "true", "Retry-After": "12" }))).toBe(
      " (the account's build queue is full: retry after 12 s, once some builds finish)"
    );
  });

  it("follows the server's retry signal over the plan quotas link", () => {
    const linked = JSON.stringify({ error: "over quota, see https://app.blaxel.ai/account/plan-quotas?id=acc", code: 429 });
    expect(buildLimitHint(429, linked, new Headers({ "x-should-retry": "true" }))).toBe(" (rate limited: retry with backoff)");
    expect(buildLimitHint(429, JSON.stringify({ code: "RATE_LIMIT_EXCEEDED" }), new Headers({ "X-Should-Retry": "false" }))).toBe(
      " (the server says not to retry)"
    );
    expect(buildLimitHint(429, JSON.stringify({ error: "busy", code: 429, retryable: true }))).toBe(" (rate limited: retry with backoff)");
  });
});
