/**
 * Response interceptors for the Blaxel SDK client.
 *
 * Interceptors run in order:
 *  1. {@link authenticationErrorInterceptor} — enriches 401/403 bodies
 *  2. {@link apiErrorInterceptor} — throws {@link BlaxelAPIError} on 4xx/5xx
 */

import { settings } from "../common/settings.js";
import { BlaxelAPIError } from "./errors.js";

type ResponseInterceptor = (
  response: Response
) => Promise<Response>;

/**
 * Intercepts HTTP responses and adds authentication documentation
 * to 401/403 error responses
 */
export const authenticationErrorInterceptor: ResponseInterceptor = async (
  response: Response
) => {
  // Only process authentication errors (401/403)
  if (response.status !== 401 && response.status !== 403) {
    return response;
  }

  // Clone the response so we can modify it
  const clonedResponse = response.clone();

  try {
    // Read the original response body
    const bodyText = await clonedResponse.text();

    // Try to parse as JSON
    let enhancedBody: string;
    try {
      const originalError: Record<string, unknown> = JSON.parse(bodyText) as Record<string, unknown>;

      // Create enhanced error with authentication documentation
      const authError: Record<string, unknown> = {
        ...originalError,
        documentation:
          "For more information on authentication, visit: https://docs.blaxel.ai/sdk-reference/introduction#how-authentication-works",
      };

      enhancedBody = JSON.stringify(authError);
    } catch {
      // If not JSON, just append the documentation as text
      enhancedBody = `${bodyText}\nFor more information on authentication, visit: https://docs.blaxel.ai/sdk-reference/introduction#how-authentication-works`;
    }

    // Create a new response with the enhanced body
    return new Response(enhancedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    // If anything fails, return the original response
    console.error("Error processing authentication error response:", error);
    return response;
  }
};

/**
 * Throws {@link BlaxelAPIError} for every HTTP 4xx/5xx response,
 * matching the Go SDK's auto-raise behaviour.
 *
 * Gated by `settings.throwOnError` (default `true`). When disabled the
 * response passes through unchanged and callers can inspect `{ data, error }`
 * tuples as before.
 */
export const apiErrorInterceptor: ResponseInterceptor = async (
  response: Response
) => {
  if (!settings.throwOnError || response.status < 400) {
    return response;
  }

  const clonedResponse = response.clone();

  let errorBody: unknown;
  let errorCode: string | undefined;

  try {
    const bodyText = await clonedResponse.text();
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      errorBody = parsed;
      if (typeof parsed.code === "string") {
        errorCode = parsed.code;
      } else if (typeof parsed.error_code === "string") {
        errorCode = parsed.error_code;
      }
    } catch {
      errorBody = bodyText;
    }
  } catch {
    errorBody = undefined;
  }

  throw new BlaxelAPIError(response.status, errorBody, response, errorCode);
};

export const responseInterceptors: ResponseInterceptor[] = [
  authenticationErrorInterceptor,
  apiErrorInterceptor,
];

