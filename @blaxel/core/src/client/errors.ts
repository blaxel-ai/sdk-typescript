/**
 * Error thrown when the Blaxel API returns a 4xx or 5xx response.
 *
 * Mirrors the Go SDK's auto-raise behavior (sdk-go `internal/apierror`).
 *
 * @example
 * ```typescript
 * import { BlaxelAPIError, getAgent } from "@blaxel/core";
 *
 * try {
 *   const { data } = await getAgent({ path: { agentName: "my-agent" } });
 * } catch (err) {
 *   if (err instanceof BlaxelAPIError) {
 *     console.error(err.statusCode);   // e.g. 404
 *     console.error(err.errorBody);     // parsed JSON body
 *     console.error(err.errorCode);     // e.g. "not_found" (if present)
 *   }
 * }
 * ```
 */
export class BlaxelAPIError extends Error {
  /**
   * The `code` field from the API JSON body (numeric status or string error
   * code, e.g. `409`, `"SANDBOX_ALREADY_EXISTS"`).  Falls back to the HTTP
   * status code when the body does not contain a `code` field.
   *
   * Exposed so that existing `catch` blocks that test `e.code` keep working.
   */
  public code: number | string;

  constructor(
    public statusCode: number,
    public errorBody: unknown,
    public response: Response,
    public errorCode?: string,
  ) {
    super(`API error ${statusCode}: ${JSON.stringify(errorBody)}`);
    this.name = "BlaxelAPIError";

    // Prefer the `code` value from the parsed body (may be a string like
    // "SANDBOX_ALREADY_EXISTS" or a number like 409). Fall back to the HTTP
    // status code so callers can always compare against `e.code`.
    if (
      errorBody &&
      typeof errorBody === "object" &&
      "code" in errorBody &&
      (typeof (errorBody as Record<string, unknown>).code === "number" ||
        typeof (errorBody as Record<string, unknown>).code === "string")
    ) {
      this.code = (errorBody as Record<string, unknown>).code as number | string;
    } else {
      this.code = statusCode;
    }
  }
}
