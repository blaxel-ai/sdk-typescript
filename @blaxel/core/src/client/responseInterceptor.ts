/**
 * Response interceptors for the Blaxel SDK.
 *
 * - Gateway error interceptor: detects gateway-synthesized errors and throws GatewayError
 * - Authentication error interceptor: enhances 401/403 messages with doc links
 */

import { GatewayError } from "./gatewayError.js";

type ResponseInterceptor = (
  response: Response
) => Promise<Response>;

/**
 * Intercepts HTTP responses from the Blaxel gateway proxy and throws a
 * {@link GatewayError} when the response was synthesized by the gateway
 * (identified by the `X-Blaxel-Source: platform` header).
 */
export const gatewayErrorInterceptor: ResponseInterceptor = async (
  response: Response
) => {
  if (response.headers.get("X-Blaxel-Source") !== "platform") {
    return response;
  }

  if (response.ok) {
    return response;
  }

  const cloned = response.clone();
  let errorObj: Record<string, unknown> = {};
  try {
    const body: unknown = await cloned.json();
    if (body && typeof body === "object" && "error" in (body as Record<string, unknown>)) {
      const raw = (body as Record<string, unknown>).error;
      if (raw && typeof raw === "object") {
        errorObj = raw as Record<string, unknown>;
      }
    }
  } catch {
    // body is not JSON — proceed with empty errorObj
  }

  throw new GatewayError({
    errorCode: response.headers.get("X-Blaxel-Error-Code") ?? "",
    message: typeof errorObj.message === "string" ? errorObj.message : response.statusText,
    statusCode: response.status,
    retryable: Boolean(errorObj.retryable),
    action: typeof errorObj.action === "string" ? errorObj.action : "",
    doNot: typeof errorObj.do_not === "string" ? errorObj.do_not : undefined,
    docsUrl: typeof errorObj.docs_url === "string" ? errorObj.docs_url : undefined,
    response,
  });
};

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

export const responseInterceptors: ResponseInterceptor[] = [
  gatewayErrorInterceptor,
  authenticationErrorInterceptor,
];

