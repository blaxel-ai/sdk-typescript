import { ResponseError } from "../sandbox/action.js";
import { SandboxCreationTimeoutError } from "../sandbox/sandbox.js";

/**
 * Codes the edge gateway returns for sandbox, agent, function and MCP URLs,
 * in `error.code` and the `X-Blaxel-Error-Code` header.
 */
export type BlaxelGatewayErrorCode =
  /** 404: the URL does not map to a known workload. */
  | "ROUTE_NOT_FOUND"
  /** 404 (401 for unauthenticated callers): the workload does not exist. */
  | "WORKLOAD_NOT_FOUND"
  /** 404: the workspace in the URL does not exist. */
  | "WORKSPACE_NOT_FOUND"
  /** 404, retryable: the workload exists but is not serving. */
  | "WORKLOAD_UNAVAILABLE"
  /** The workload failed and will not serve. */
  | "WORKLOAD_FAILED"
  /** Retryable: routing is briefly unavailable. */
  | "ROUTING_UNAVAILABLE"
  /** 401: no credentials were sent. */
  | "AUTHENTICATION_REQUIRED"
  /** 401: the credentials were rejected. */
  | "AUTHENTICATION_FAILED"
  /** 401: the token was revoked; get a new one. */
  | "TOKEN_REVOKED"
  /** 403: authenticated but not allowed on this resource. */
  | "FORBIDDEN"
  /** 400: malformed request. */
  | "BAD_REQUEST"
  /** 402: the workspace exceeded its plan's usage limits. */
  | "USAGE_LIMIT_EXCEEDED"
  /** Reserved: defined by the gateway but not currently returned. */
  | "POLICY_VIOLATION"
  /** Retryable: could not connect to the workload. */
  | "UPSTREAM_CONNECT_FAILED"
  /** Retryable: connecting to the workload timed out. */
  | "UPSTREAM_CONNECT_TIMEOUT"
  /** Retryable: the request to the workload failed. */
  | "UPSTREAM_ERROR"
  /** Retryable: the workload did not answer in time. */
  | "UPSTREAM_TIMEOUT"
  /** Retryable: the gateway itself failed. */
  | "GATEWAY_INTERNAL_ERROR";

/**
 * Authentication/authorization codes from sandbox creation and fork.
 * `TOKEN_REVOKED` is also returned by every control-plane endpoint.
 */
export type BlaxelAuthErrorCode =
  /** 401: the token was revoked; get a new one. */
  | "TOKEN_REVOKED"
  /** 403: the credentials were rejected. */
  | "UNAUTHORIZED"
  /** 403: no (write) access to the requested workspace. */
  | "UNAUTHORIZED_WORKSPACE"
  /** 503, retryable: credentials could not be verified right now. */
  | "AUTHENTICATION_UNAVAILABLE"
  /** 400: the credentials reach several workspaces (or none); set one. */
  | "WORKSPACE_REQUIRED";

/** Codes the control plane returns when creating or forking a sandbox. */
export type BlaxelSandboxCreationErrorCode =
  // Invalid request (400)
  | "READ_FAILED"
  | "PARSE_FAILED"
  | "VALIDATION_FAILED"
  | "VALIDATION_ERROR"
  | "INVALID_INPUT"
  | "INVALID_IMAGE"
  | "IMAGE_NOT_FOUND"
  | "UPLOAD_NOT_SUPPORTED"
  | "UNSUPPORTED_GENERATION"
  | "KERNEL_GENERATION_MISMATCH"
  | "INVALID_PORTS"
  | "INVALID_REGION"
  | "REGION_MISMATCH"
  | "INVALID_VOLUME"
  | "INVALID_VOLUME_COUNT"
  | "INVALID_VOLUME_REGION"
  | "VOLUME_ALREADY_ATTACHED"
  | "VOLUME_PROVIDER_MISMATCH"
  // Not found (404)
  | "VOLUME_NOT_FOUND"
  | "WORKSPACE_NOT_FOUND"
  | "ACCOUNT_NOT_FOUND"
  // Conflict (409). SANDBOX_ALREADY_EXISTS can carry reason: "CREATION_IN_PROGRESS".
  | "SANDBOX_ALREADY_EXISTS"
  | "SANDBOX_DELETION_IN_PROGRESS"
  | "SANDBOX_DELETED"
  | "VOLUME_DELETED"
  // Creation deadline exceeded (408); the name is free again.
  | "CREATION_TIMEOUT"
  // Limits (400/429)
  | "QUOTA_EXCEEDED"
  | "RATE_LIMIT_EXCEEDED"
  | "WORKSPACE_RATE_LIMIT_EXCEEDED"
  // Server-side failures (5xx)
  | "SERVICE_UNAVAILABLE"
  | "DATABASE_ERROR"
  | "LOCK_ACQUISITION_FAILED"
  | "VOLUME_LOOKUP_FAILED"
  | "BUILD_TRIGGER_ERROR"
  | "PRESIGNED_URL_ERROR"
  | "UPLOAD_UNAVAILABLE"
  | "DEPLOYMENT_FAILED"
  | "CLUSTER_GATEWAY_ERROR"
  | "LOCKDOWN_ERROR"
  | "PROXY_CONFIG_ERROR"
  | "VALIDATED_DATA_ERROR"
  | "WORKSPACE_DATA_MISSING"
  | "CALLBACK_SEND_FAILED"
  | "FORK_FAILED"
  | "HANDLER_ERROR"
  | "INTERNAL_ERROR"
  | "UNKNOWN_ERROR";

/** Known backend codes, including the reserved POLICY_VIOLATION code. */
export type BlaxelErrorCode =
  | BlaxelGatewayErrorCode
  | BlaxelAuthErrorCode
  | BlaxelSandboxCreationErrorCode;

/** Known/new string codes, or the numeric HTTP code of a generic control-plane body. */
export type BlaxelErrorCodeValue = BlaxelErrorCode | (string & Record<never, never>) | number;

/** Generic control-plane error body, returned by most `/v0` endpoints. */
export type BlaxelApiErrorBody = {
  /** Human-readable message. */
  error: string;
  /** HTTP status code (a number, not a string code). */
  code: number;
};

/** Control-plane error body of sandbox creation and fork. */
export type BlaxelActionErrorBody = {
  code: BlaxelSandboxCreationErrorCode | BlaxelAuthErrorCode | (string & Record<never, never>);
  message: string;
  /** HTTP status code. */
  status_code: number;
  /** Extra discriminant, e.g. "CREATION_IN_PROGRESS" on SANDBOX_ALREADY_EXISTS. */
  reason?: string;
  /** Creation step that failed. */
  step?: string;
  workspace?: string;
  sandbox_name?: string;
  timestamp?: string;
  cause?: string;
  details?: Record<string, unknown>;
};

/** Edge gateway error body; also used by the control plane for TOKEN_REVOKED. */
export type BlaxelPlatformErrorBody = {
  error: {
    code: BlaxelGatewayErrorCode | (string & Record<never, never>);
    message: string;
    /** HTTP status code. */
    status: number;
    /** When present, "platform": the gateway answered, not the workload. */
    origin?: "platform";
    /** Whether retrying the same request can succeed. */
    retryable?: boolean;
    /** Whether the workload may have seen the request before it failed. */
    dispatch_state?: "not_dispatched" | "dispatched_unknown";
    /** True only when retryable and the workload never saw the request. */
    safe_to_retry_request?: boolean;
    action?: string;
    do_not?: string;
    docs_url?: string;
    timestamp?: string;
  };
};

/**
 * Error body of the sandbox API (`sandbox.fs`, `sandbox.process`, ...). It has no
 * code or status of its own: callers receive it inside `ResponseError`
 * (`err.data` or `err.error`), which carries the HTTP status.
 */
export type BlaxelSandboxApiErrorBody = {
  error: string;
};

/**
 * Values {@link isBlaxelError} recognizes: the error classes the SDK throws for
 * API failures (`ResponseError`, which includes `SandboxGatewayError`, and
 * `SandboxCreationTimeoutError`) and the raw error bodies the control-plane
 * client throws, each with its required code and status fields. This is a union
 * of existing values, not a new error class or normalized shape.
 */
export type BlaxelErrorLike =
  | ResponseError
  | SandboxCreationTimeoutError
  | BlaxelApiErrorBody
  | Pick<BlaxelActionErrorBody, "code" | "message" | "status_code">
  | { error: Pick<BlaxelPlatformErrorBody["error"], "code" | "message" | "status"> };

function readProperty(value: unknown, key: string): unknown {
  try {
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  } catch {
    // Catch hostile getters and revoked proxies, including in custom transports.
    return undefined;
  }
}

const isCode = (value: unknown): value is BlaxelErrorCodeValue =>
  (typeof value === "string" && value.length > 0) ||
  (typeof value === "number" && Number.isFinite(value));

const isStatus = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;

/**
 * True only for a value that carries a Blaxel error code or HTTP status in a
 * shape the SDK throws for API failures: a `ResponseError` (including
 * `SandboxGatewayError`), a `SandboxCreationTimeoutError`, or a raw control-plane
 * error body (`{ error, code }`, `{ code, message, status_code }` or
 * `{ error: { code, message, status } }`). Plain `Error`s (including network
 * errors with a `code` such as `ECONNRESET`), strings, raw HTML/text bodies, empty
 * bodies and a bare `{ error: string }` are false: they carry neither. Matching
 * `ResponseError` uses `instanceof`, so an error thrown by a second copy of
 * `@blaxel/core` does not match. Does not wrap or mutate the value. Never throws.
 * Like `is_blaxel_error` in the Python SDK, it is false for plain exceptions and
 * strings.
 */
export function isBlaxelError(err: unknown): err is BlaxelErrorLike {
  try {
    if (err instanceof Error) {
      return err instanceof ResponseError || err instanceof SandboxCreationTimeoutError;
    }
    if (typeof err !== "object" || err === null || Array.isArray(err)) return false;
    const error = readProperty(err, "error");
    if (typeof error === "string") return isStatus(readProperty(err, "code"));
    if (
      typeof readProperty(err, "code") === "string" &&
      typeof readProperty(err, "message") === "string" &&
      isStatus(readProperty(err, "status_code"))
    ) return true;
    return (
      typeof error === "object" && error !== null && !Array.isArray(error) &&
      typeof readProperty(error, "code") === "string" &&
      typeof readProperty(error, "message") === "string" &&
      isStatus(readProperty(error, "status"))
    );
  } catch {
    return false;
  }
}

// Fixed-depth inspection: ResponseError carries `error`/`data`; gateway bodies
// nest their fields once more in `error`. No recursion, including on cyclic input.
function errorCandidates(err: unknown): unknown[] {
  const bodies = [err, readProperty(err, "error"), readProperty(err, "data")];
  return bodies.flatMap((body) => [body, readProperty(body, "error")]);
}

function readHeader(err: unknown, name: string): string | undefined {
  try {
    const headers = readProperty(readProperty(err, "response"), "headers");
    const get = readProperty(headers, "get");
    if (typeof get !== "function") return undefined;
    const value: unknown = Reflect.apply(get, headers, [name]);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Read a code from the existing error/body, then X-Blaxel-Error-Code. Never throws. */
export function getBlaxelErrorCode(err: unknown): BlaxelErrorCodeValue | undefined {
  for (const candidate of errorCandidates(err)) {
    const code = readProperty(candidate, "code");
    if (isCode(code)) return code;
  }
  return readHeader(err, "x-blaxel-error-code");
}

/**
 * Read HTTP status from the existing error/response, then the body (`status`,
 * `status_code`, or a numeric `code`). Raw text and plain Error have none.
 * Never throws.
 */
export function getBlaxelErrorStatus(err: unknown): number | undefined {
  const status = readProperty(err, "status");
  if (isStatus(status)) return status;
  const responseStatus = readProperty(readProperty(err, "response"), "status");
  if (isStatus(responseStatus)) return responseStatus;
  for (const candidate of errorCandidates(err)) {
    for (const key of ["status", "status_code", "code"]) {
      const value = readProperty(candidate, key);
      if (isStatus(value)) return value;
    }
  }
  return undefined;
}

/**
 * Read the existing Error.message, body message/error text, or raw text/HTML.
 * Returns undefined for an empty/unrecognized body. Never throws.
 */
export function getBlaxelErrorMessage(err: unknown): string | undefined {
  for (const candidate of errorCandidates(err)) {
    const message = typeof candidate === "string" ? candidate : readProperty(candidate, "message");
    if (typeof message === "string" && message.length > 0) return message;
  }
  return undefined;
}

/**
 * Read X-Cf-Request-Id, X-Amz-Cf-Id, then CF-Ray from a retained response.
 * Raw control-plane bodies and SandboxCreationTimeoutError do not retain
 * response headers, so their request ID is unavailable. Never throws.
 */
export function getBlaxelErrorRequestId(err: unknown): string | undefined {
  for (const name of ["x-cf-request-id", "x-amz-cf-id", "cf-ray"]) {
    const value = readHeader(err, name);
    if (value !== undefined) return value;
  }
  return undefined;
}
