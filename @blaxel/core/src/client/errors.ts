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
  constructor(
    public statusCode: number,
    public errorBody: unknown,
    public response: Response,
    public errorCode?: string,
  ) {
    super(`API error ${statusCode}: ${JSON.stringify(errorBody)}`);
    this.name = "BlaxelAPIError";
  }
}
