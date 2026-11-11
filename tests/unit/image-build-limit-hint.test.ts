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
});
