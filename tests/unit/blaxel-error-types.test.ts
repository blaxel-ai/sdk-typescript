import {
  type BlaxelActionErrorBody,
  type BlaxelApiErrorBody,
  type BlaxelAuthErrorCode,
  type BlaxelErrorCode,
  type BlaxelErrorCodeValue,
  type BlaxelErrorLike,
  type BlaxelGatewayErrorCode,
  type BlaxelPlatformErrorBody,
  type BlaxelSandboxApiErrorBody,
  type BlaxelSandboxCreationErrorCode,
  getBlaxelErrorCode,
  getBlaxelErrorMessage,
  getBlaxelErrorRequestId,
  getBlaxelErrorStatus,
  getSandbox,
  isBlaxelError,
  ResponseError,
  SandboxCreationTimeoutError,
  SandboxGatewayError,
} from "@blaxel/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import { SandboxAction } from "../../@blaxel/core/src/sandbox/action.js";

const generic: BlaxelApiErrorBody = { code: 404, error: "Sandbox not found" };
const action: BlaxelActionErrorBody = {
  code: "SANDBOX_ALREADY_EXISTS",
  message: "Sandbox sbx already exists",
  status_code: 409,
  reason: "CREATION_IN_PROGRESS",
};
const platform: BlaxelPlatformErrorBody = {
  error: {
    code: "WORKLOAD_UNAVAILABLE",
    message: "The workload is not available.",
    status: 404,
    origin: "platform",
    retryable: true,
    dispatch_state: "not_dispatched",
    safe_to_retry_request: true,
  },
};
const sandboxBody: BlaxelSandboxApiErrorBody = { error: "process not found" };

const readers = [
  getBlaxelErrorCode,
  getBlaxelErrorStatus,
  getBlaxelErrorMessage,
  getBlaxelErrorRequestId,
];

// The same generated client used by the control plane, without network/auth
// interceptors. Exercises its actual parsing and throwOnError behavior.
async function thrownBody(text: string, status: number): Promise<unknown> {
  const client = new SandboxAction({
    metadata: { name: "test" }, spec: {}, forceUrl: "https://api.test", headers: {},
  }).client;
  return getSandbox({
    client,
    path: { sandboxName: "test" },
    fetch: () => Promise.resolve(new Response(text, {
      status, headers: { "x-cf-request-id": "not-retained" },
    })),
    throwOnError: true,
  }).catch((err: unknown) => err);
}

describe("existing control-plane thrown values", () => {
  it.each([
    { body: generic, code: 404, status: 404, message: generic.error },
    { body: action, code: action.code, status: 409, message: action.message },
    { body: platform, code: platform.error.code, status: 404, message: platform.error.message },
    { body: sandboxBody, code: undefined, status: undefined, message: sandboxBody.error },
  ])("reads $code without wrapping or adding fields", async ({ body, code, status, message }) => {
    const err = await thrownBody(JSON.stringify(body), status ?? 404);
    const keys = Object.keys(err as object);
    const serialized = JSON.stringify(err);
    const stringified = String(err);
    expect(err).toEqual(body);
    expect(err).not.toBeInstanceOf(Error);
    expect(isBlaxelError(err)).toBe(true);
    expect(getBlaxelErrorCode(err)).toBe(code);
    expect(getBlaxelErrorStatus(err)).toBe(status);
    expect(getBlaxelErrorMessage(err)).toBe(message);
    // No response is retained on the raw thrown body, even if it had headers.
    expect(getBlaxelErrorRequestId(err)).toBeUndefined();
    expect(Object.keys(err as object)).toEqual(keys);
    expect(JSON.stringify(err)).toBe(serialized);
    expect(String(err)).toBe(stringified);
    expect(structuredClone(err)).toEqual(body);
  });

  it("accepts future string codes without pretending they are known", () => {
    const err = { code: "FUTURE_CODE", message: "new failure", status_code: 400 };
    expect(isBlaxelError(err)).toBe(true);
    expect(getBlaxelErrorCode(err)).toBe("FUTURE_CODE");
    expect(getBlaxelErrorStatus(err)).toBe(400);
  });

  it("reads the TOKEN_REVOKED platform envelope", () => {
    const err = { error: { code: "TOKEN_REVOKED", message: "Token revoked", status: 401 } };
    expect(isBlaxelError(err)).toBe(true);
    expect(getBlaxelErrorCode(err)).toBe("TOKEN_REVOKED");
    expect(getBlaxelErrorStatus(err)).toBe(401);
    expect(getBlaxelErrorMessage(err)).toBe("Token revoked");
  });

  it("keeps an HTML/string body as text, with no invented metadata", async () => {
    const html = "<html><body>502 Bad Gateway</body></html>";
    const err = await thrownBody(html, 502);
    expect(err).toBe(html);
    expect(isBlaxelError(err)).toBe(true);
    expect(getBlaxelErrorMessage(err)).toBe(html);
    expect(getBlaxelErrorCode(err)).toBeUndefined();
    expect(getBlaxelErrorStatus(err)).toBeUndefined();
    expect(getBlaxelErrorRequestId(err)).toBeUndefined();
  });

  it("handles the empty body that the client throws as {}", async () => {
    const err = await thrownBody("", 503);
    expect(err).toEqual({});
    expect(isBlaxelError(err)).toBe(false);
    for (const read of readers) expect(read(err)).toBeUndefined();
  });
});

describe("existing Error classes", () => {
  it("reads ResponseError.error and headers without changing the instance", () => {
    const response = new Response(null, { status: 404, headers: {
      "x-blaxel-error-code": "WORKLOAD_NOT_FOUND",
      "x-cf-request-id": "req-1",
      "x-amz-cf-id": "amz-1",
      "cf-ray": "ray-1",
    } });
    const err = new ResponseError(response, undefined, platform);
    const before = Object.getOwnPropertyDescriptors(err);
    expect(isBlaxelError(err)).toBe(true);
    expect(getBlaxelErrorCode(err)).toBe("WORKLOAD_UNAVAILABLE");
    expect(getBlaxelErrorStatus(err)).toBe(404);
    expect(getBlaxelErrorMessage(err)).toBe(err.message);
    expect(getBlaxelErrorRequestId(err)).toBe("req-1");
    expect(Object.getOwnPropertyDescriptors(err)).toEqual(before);
    expect(Object.keys(err)).not.toContain("code");
    expect(Object.keys(err)).not.toContain("requestId");
    expect(err.error).toBe(platform);
    expect(err.response).toBe(response);
  });

  it("reads the data fallback on ResponseError", () => {
    const err = new ResponseError(new Response(null, { status: 404 }), generic, undefined);
    expect(isBlaxelError(err)).toBe(true);
    expect(getBlaxelErrorCode(err)).toBe(404);
    expect(getBlaxelErrorStatus(err)).toBe(404);
    expect(getBlaxelErrorMessage(err)).toBe(err.message);
  });

  it("reads SandboxGatewayError with an HTML body and header-only code", () => {
    const err = new SandboxGatewayError(new Response(null, {
      status: 504, headers: { "x-blaxel-error-code": "UPSTREAM_TIMEOUT", "x-amz-cf-id": "amz-2" },
    }), undefined, "<html>Gateway Timeout</html>");
    expect(isBlaxelError(err)).toBe(true);
    expect(getBlaxelErrorCode(err)).toBe("UPSTREAM_TIMEOUT");
    expect(getBlaxelErrorStatus(err)).toBe(504);
    expect(getBlaxelErrorMessage(err)).toBe(err.message);
    expect(getBlaxelErrorRequestId(err)).toBe("amz-2");
  });

  it("reads a SandboxGatewayError with an empty body", () => {
    const err = new SandboxGatewayError(new Response(null, { status: 503 }), undefined, undefined);
    expect(isBlaxelError(err)).toBe(true);
    expect(getBlaxelErrorCode(err)).toBeUndefined();
    expect(getBlaxelErrorStatus(err)).toBe(503);
    expect(getBlaxelErrorMessage(err)).toBe(err.message);
    expect(getBlaxelErrorRequestId(err)).toBeUndefined();
  });

  it("reads SandboxCreationTimeoutError without inventing a response/request ID", () => {
    const body: BlaxelActionErrorBody = {
      code: "CREATION_TIMEOUT", message: "Creation deadline exceeded", status_code: 408,
    };
    const err = new SandboxCreationTimeoutError("sbx", 10, body);
    const before = Object.getOwnPropertyDescriptors(err);
    expect(isBlaxelError(err)).toBe(true);
    expect(getBlaxelErrorCode(err)).toBe("CREATION_TIMEOUT");
    expect(getBlaxelErrorStatus(err)).toBe(408);
    expect(getBlaxelErrorMessage(err)).toBe(err.message);
    expect(getBlaxelErrorRequestId(err)).toBeUndefined();
    expect(Object.getOwnPropertyDescriptors(err)).toEqual(before);
    expect(err.data).toBe(body);
  });

  it("accepts a plain Error with only its existing message", () => {
    const err = new Error("Failed to upload file");
    expect(isBlaxelError(err)).toBe(true);
    expect(getBlaxelErrorMessage(err)).toBe("Failed to upload file");
    expect(getBlaxelErrorCode(err)).toBeUndefined();
    expect(getBlaxelErrorStatus(err)).toBeUndefined();
    expect(getBlaxelErrorRequestId(err)).toBeUndefined();
  });

  it("uses CF-Ray as the last request ID fallback", () => {
    const err = new ResponseError(new Response(null, {
      status: 400, headers: { "cf-ray": "ray-3" },
    }), undefined, sandboxBody);
    expect(getBlaxelErrorRequestId(err)).toBe("ray-3");
  });

  it("accepts a bare response without headers (custom fetch/test implementations)", () => {
    const err = new ResponseError({ status: 404 } as Response, undefined, sandboxBody);
    expect(isBlaxelError(err)).toBe(true);
    expect(getBlaxelErrorStatus(err)).toBe(404);
    expect(getBlaxelErrorRequestId(err)).toBeUndefined();
  });
});

describe("safe inspection of unknown values", () => {
  it.each([undefined, null, false, 0, 123n, Symbol("error"), [], {}, "", { error: 123 },
    { code: "INVALID_IMAGE", message: "bad" },
    { error: { code: "BAD_REQUEST", message: "bad", status: "400" } },
  ])("does not throw for %s", (err) => {
    expect(isBlaxelError(err)).toBe(false);
    for (const read of readers) expect(() => read(err)).not.toThrow();
  });

  it("does not coerce numeric/string codes or invalid statuses", () => {
    expect(getBlaxelErrorCode({ code: 404 })).toBe(404);
    expect(getBlaxelErrorCode({ code: "404" })).toBe("404");
    expect(getBlaxelErrorStatus({ code: "404" })).toBeUndefined();
    for (const value of [NaN, Infinity, -1, 0, 600, 404.5, "404"]) {
      expect(getBlaxelErrorStatus({ status: value })).toBeUndefined();
    }
    expect(getBlaxelErrorCode({ code: NaN })).toBeUndefined();
  });

  it("bounds inspection of cyclic objects", () => {
    const err: Record<string, unknown> = {};
    err.error = err;
    err.data = err;
    expect(isBlaxelError(err)).toBe(false);
    for (const read of readers) expect(read(err)).toBeUndefined();
  });

  it("never throws for hostile getters, proxies or header implementations", () => {
    const hostile = new Proxy({}, { get() { throw new Error("getter failed"); } });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const badHeaders = { response: { headers: { get() { throw new Error("header failed"); } } } };
    const badGet = { response: { get headers() { throw new Error("headers failed"); } } };
    for (const err of [hostile, revoked.proxy, badHeaders, badGet]) {
      expect(isBlaxelError(err)).toBe(false);
      for (const read of readers) expect(read(err)).toBeUndefined();
    }
  });

  it("does not mutate frozen bodies", () => {
    const err = Object.freeze(action);
    expect(isBlaxelError(err)).toBe(true);
    expect(getBlaxelErrorCode(err)).toBe("SANDBOX_ALREADY_EXISTS");
    expect(getBlaxelErrorStatus(err)).toBe(409);
    expect(getBlaxelErrorMessage(err)).toBe(action.message);
    expect(getBlaxelErrorRequestId(err)).toBeUndefined();
  });

  it("exports the code catalogs/body types and narrows only the existing shape", () => {
    const err: unknown = action;
    if (isBlaxelError(err)) expectTypeOf(err).toEqualTypeOf<BlaxelErrorLike>();
    expectTypeOf<"POLICY_VIOLATION">().toMatchTypeOf<BlaxelGatewayErrorCode>();
    expectTypeOf<"TOKEN_REVOKED">().toMatchTypeOf<BlaxelAuthErrorCode>();
    expectTypeOf<"CREATION_TIMEOUT">().toMatchTypeOf<BlaxelSandboxCreationErrorCode>();
    expectTypeOf<BlaxelGatewayErrorCode>().toMatchTypeOf<BlaxelErrorCode>();
    expectTypeOf<BlaxelAuthErrorCode>().toMatchTypeOf<BlaxelErrorCode>();
    expectTypeOf<BlaxelSandboxCreationErrorCode>().toMatchTypeOf<BlaxelErrorCode>();
    expectTypeOf(getBlaxelErrorCode(err)).toEqualTypeOf<BlaxelErrorCodeValue | undefined>();
  });
});
