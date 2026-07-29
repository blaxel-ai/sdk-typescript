import { describe, expect, it } from "vitest";

import {
  ResponseError,
  SandboxAction,
  SandboxGatewayError,
  isGatewayError,
  isGatewayTimeout,
} from "../../@blaxel/core/src/sandbox/action.js";
import type { SandboxConfiguration } from "../../@blaxel/core/src/sandbox/types.js";

// Minimal action whose only job is to expose the protected-ish error handler
// against scripted responses.
class TestAction extends SandboxAction {}

const action = () =>
  new TestAction({ metadata: { name: "test" }, spec: {} } as SandboxConfiguration);

const response = (status: number, statusText = "") =>
  ({ ok: status >= 200 && status < 300, status, statusText }) as Response;

describe("handleResponseError gateway classification", () => {
  it("throws a SandboxGatewayError for 502/503/504", () => {
    for (const status of [502, 503, 504]) {
      let thrown: unknown;
      try {
        action().handleResponseError(response(status), undefined, undefined);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SandboxGatewayError);
      expect(thrown).toBeInstanceOf(ResponseError);
      expect((thrown as ResponseError).status).toBe(status);
      // Human-readable, not the old `{"status":504}` blob.
      expect((thrown as Error).message).toContain("edge gateway");
    }
  });

  it("throws a plain ResponseError for a non-gateway failure with a readable message", () => {
    let thrown: unknown;
    try {
      action().handleResponseError(
        response(404, "Not Found"),
        { error: "process not found" },
        undefined,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ResponseError);
    expect(thrown).not.toBeInstanceOf(SandboxGatewayError);
    const err = thrown as ResponseError;
    expect(err.status).toBe(404);
    expect(err.message).toBe("Sandbox request failed with status 404 Not Found: process not found");
  });

  it("does not throw on a 2xx with data", () => {
    expect(() =>
      action().handleResponseError(response(200), { ok: true }, undefined),
    ).not.toThrow();
  });

  it("isGatewayTimeout matches only 504; isGatewayError matches 502/503/504", () => {
    const make = (status: number) =>
      new SandboxGatewayError(response(status), undefined, undefined);
    expect(isGatewayTimeout(make(504))).toBe(true);
    expect(isGatewayTimeout(make(503))).toBe(false);
    expect(isGatewayError(make(502))).toBe(true);
    expect(isGatewayError(make(503))).toBe(true);
    expect(isGatewayError(make(504))).toBe(true);

    const notGateway = new ResponseError(response(500), undefined, undefined);
    expect(isGatewayTimeout(notGateway)).toBe(false);
    expect(isGatewayError(notGateway)).toBe(false);
    expect(isGatewayTimeout(new Error("boom"))).toBe(false);
    expect(isGatewayError(undefined)).toBe(false);
  });
});
