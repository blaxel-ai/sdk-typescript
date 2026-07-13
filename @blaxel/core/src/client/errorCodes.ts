/**
 * Stable error codes emitted by the Blaxel gateway proxy via the
 * `X-Blaxel-Error-Code` response header and the `error.code` JSON body field.
 *
 * @example
 * ```typescript
 * import { GatewayError, ERR_WORKLOAD_UNAVAILABLE } from "@blaxel/core";
 *
 * try {
 *   await someApiCall();
 * } catch (err) {
 *   if (err instanceof GatewayError && err.errorCode === ERR_WORKLOAD_UNAVAILABLE) {
 *     // retry with backoff
 *   }
 * }
 * ```
 */

export const ERR_ROUTE_NOT_FOUND = "ROUTE_NOT_FOUND" as const;
export const ERR_WORKLOAD_NOT_FOUND = "WORKLOAD_NOT_FOUND" as const;
export const ERR_WORKSPACE_NOT_FOUND = "WORKSPACE_NOT_FOUND" as const;
export const ERR_WORKLOAD_UNAVAILABLE = "WORKLOAD_UNAVAILABLE" as const;
export const ERR_AUTHENTICATION_REQUIRED = "AUTHENTICATION_REQUIRED" as const;
export const ERR_AUTHENTICATION_FAILED = "AUTHENTICATION_FAILED" as const;
export const ERR_FORBIDDEN = "FORBIDDEN" as const;
export const ERR_BAD_REQUEST = "BAD_REQUEST" as const;
export const ERR_USAGE_LIMIT_EXCEEDED = "USAGE_LIMIT_EXCEEDED" as const;
export const ERR_POLICY_VIOLATION = "POLICY_VIOLATION" as const;
