import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ResponseError } from "../../@blaxel/core/src/sandbox/action.js";
import {
  isTransientResetError,
  retryOnTransientReset,
} from "../../@blaxel/core/src/common/transient-retry.js";

// Reproducer for the WORKLOAD_UNAVAILABLE 404 issue.
//
// The cluster-gateway returns HTTP 404 with two distinct error codes:
//   * WORKLOAD_UNAVAILABLE (retryable=true):  sandbox exists but no healthy pod
//     yet (cold start / standby wake) — the caller SHOULD retry.
//   * WORKLOAD_NOT_FOUND   (retryable=false): sandbox truly does not exist —
//     the caller should NOT retry.
//
// The SDK's transient-retry classifier short-circuits on ANY error that carries
// an HTTP status (see hasHttpResponseStatus + isTransientResetError), so a 404
// with retryable=true is treated identically to a non-retryable 404. The
// `retryable` field in the response body is never inspected anywhere in the SDK,
// and ResponseError exposes no way for customer code to tell the two apart.
//
// These tests PASS today — they document the bug as it currently exists.

// Build a ResponseError exactly the way SandboxAction.handleResponseError()
// does: a real 404 Response plus the parsed JSON body from the gateway.
function workloadResponseError(
  code: "WORKLOAD_UNAVAILABLE" | "WORKLOAD_NOT_FOUND",
  retryable: boolean,
): ResponseError {
  const body = { error: { code, retryable } };
  const response = new Response(JSON.stringify(body), {
    status: 404,
    statusText: "Not Found",
  });
  return new ResponseError(response, body, undefined);
}

describe("WORKLOAD_UNAVAILABLE 404 retry reproducer", () => {
  describe("Test 1: isTransientResetError ignores the retryable field", () => {
    it("classifies a retryable=true WORKLOAD_UNAVAILABLE 404 as NON-transient", () => {
      const err = workloadResponseError("WORKLOAD_UNAVAILABLE", true);
      // BUG: retryable=true, yet the classifier returns false purely because an
      // HTTP status is present. The retryable field is never consulted.
      expect(isTransientResetError(err)).toBe(false);
    });

    it("classifies a retryable=false WORKLOAD_NOT_FOUND 404 as NON-transient too", () => {
      const err = workloadResponseError("WORKLOAD_NOT_FOUND", false);
      expect(isTransientResetError(err)).toBe(false);
    });

    it("treats the retryable and non-retryable 404 identically (the core bug)", () => {
      const retryableErr = workloadResponseError("WORKLOAD_UNAVAILABLE", true);
      const notFoundErr = workloadResponseError("WORKLOAD_NOT_FOUND", false);
      // Both collapse to the same answer even though the gateway distinguished
      // them via `retryable`.
      expect(isTransientResetError(retryableErr)).toBe(
        isTransientResetError(notFoundErr),
      );
    });
  });

  describe("Test 2: retryOnTransientReset does not retry WORKLOAD_UNAVAILABLE", () => {
    // Small, fast backoff so the contrast case (which DOES retry) stays quick.
    const fastOptions = { retries: 3, baseDelayMs: 1, maxDelayMs: 2 };

    it("throws immediately without retrying a retryable=true 404 (call count = 1)", async () => {
      let calls = 0;
      const fn = () => {
        calls++;
        return Promise.reject(
          workloadResponseError("WORKLOAD_UNAVAILABLE", true),
        );
      };
      await expect(retryOnTransientReset(fn, fastOptions)).rejects.toThrow(
        "WORKLOAD_UNAVAILABLE",
      );
      // BUG: despite retryable=true, the operation is attempted exactly once.
      expect(calls).toBe(1);
    });

    it("DOES retry a genuine connection-reset error (contrast case)", async () => {
      let calls = 0;
      const fn = () => {
        calls++;
        return Promise.reject(
          Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
        );
      };
      await expect(retryOnTransientReset(fn, fastOptions)).rejects.toThrow(
        "ECONNRESET",
      );
      // 1 initial attempt + 3 retries = 4 total: transport resets self-heal,
      // but the retryable 404 above did not.
      expect(calls).toBe(4);
    });
  });

  describe("Test 3: ResponseError does not expose code / retryable / origin", () => {
    it("has no .code, .retryable, or .origin accessors", () => {
      const err = workloadResponseError("WORKLOAD_UNAVAILABLE", true);

      const asAny = err as unknown as Record<string, unknown>;
      expect(asAny.code).toBeUndefined();
      expect(asAny.retryable).toBeUndefined();
      expect(asAny.origin).toBeUndefined();
      expect("code" in err).toBe(false);
      expect("retryable" in err).toBe(false);
      expect("origin" in err).toBe(false);
    });

    it("forces customer code to re-parse the raw body to distinguish the two 404s", () => {
      const unavailable = workloadResponseError("WORKLOAD_UNAVAILABLE", true);
      const notFound = workloadResponseError("WORKLOAD_NOT_FOUND", false);

      // There is no structured accessor, so a caller can only tell them apart
      // by JSON-parsing the serialized message (which is not part of any
      // documented, stable contract).
      const parse = (e: ResponseError) => {
        const parsed = JSON.parse(e.message) as {
          error: { code: string; retryable: boolean };
        };
        return parsed.error;
      };

      expect(parse(unavailable).code).toBe("WORKLOAD_UNAVAILABLE");
      expect(parse(unavailable).retryable).toBe(true);
      expect(parse(notFound).code).toBe("WORKLOAD_NOT_FOUND");
      expect(parse(notFound).retryable).toBe(false);
    });
  });

  describe("Test 4: the SDK never references retryable / WORKLOAD_UNAVAILABLE", () => {
    const sourceOf = (relPath: string) =>
      readFileSync(
        fileURLToPath(new URL(relPath, import.meta.url)),
        "utf8",
      );

    const transientRetrySrc = sourceOf(
      "../../@blaxel/core/src/common/transient-retry.ts",
    );
    const actionSrc = sourceOf("../../@blaxel/core/src/sandbox/action.ts");

    it("transient-retry.ts is unaware of retryable / WORKLOAD_UNAVAILABLE", () => {
      expect(transientRetrySrc).not.toContain("retryable");
      expect(transientRetrySrc).not.toContain("WORKLOAD_UNAVAILABLE");
    });

    it("action.ts is unaware of retryable / WORKLOAD_UNAVAILABLE", () => {
      expect(actionSrc).not.toContain("retryable");
      expect(actionSrc).not.toContain("WORKLOAD_UNAVAILABLE");
    });
  });
});
