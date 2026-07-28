import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isRetryableGatewayError,
  retryOnTransientReset,
} from "../../@blaxel/core/src/common/transient-retry.js";

// Shaped like the SDK's ResponseError: carries an HTTP status.
const gatewayError = (status: number) => ({ status });
const responseStatusError = (status: number) => ({ response: { status } });

describe("isRetryableGatewayError", () => {
  it("matches 502/503/504 carried on status or response.status", () => {
    expect(isRetryableGatewayError(gatewayError(502))).toBe(true);
    expect(isRetryableGatewayError(gatewayError(503))).toBe(true);
    expect(isRetryableGatewayError(gatewayError(504))).toBe(true);
    expect(isRetryableGatewayError(responseStatusError(504))).toBe(true);
  });

  it("does not match non-gateway statuses or non-object errors", () => {
    expect(isRetryableGatewayError(gatewayError(500))).toBe(false);
    expect(isRetryableGatewayError(gatewayError(404))).toBe(false);
    expect(isRetryableGatewayError(new Error("ECONNRESET"))).toBe(false);
    expect(isRetryableGatewayError(undefined)).toBe(false);
  });
});

describe("retryOnTransientReset gateway handling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries a 504 and resolves once it clears", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(gatewayError(504))
      .mockResolvedValueOnce("ok");

    const pending = retryOnTransientReset(fn);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops after the bounded gateway budget and throws the last error", async () => {
    const err = gatewayError(504);
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(err);

    const pending = retryOnTransientReset(fn, { gatewayRetries: 2 });
    const expectation = expect(pending).rejects.toBe(err);
    await vi.advanceTimersByTimeAsync(10_000);
    await expectation;

    // initial call + 2 retries = 3 invocations
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry gateway errors when gatewayRetries is 0", async () => {
    const err = gatewayError(503);
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(err);

    await expect(retryOnTransientReset(fn, { gatewayRetries: 0 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-gateway 5xx", async () => {
    const err = gatewayError(500);
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(err);

    await expect(retryOnTransientReset(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
