/**
 * Response interceptor that enhances authentication error messages (401/403)
 * with a link to the authentication documentation.
 */

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
  // An edge firewall block is not an authentication error: the key was never
  // checked, so don't point at the authentication docs.
  if (response.headers.get("x-blaxel-error-code") === "REQUEST_BLOCKED") {
    return response;
  }

  // Clone the response so we can modify it
  const clonedResponse = response.clone();

  try {
    // Read the original response body
    const bodyText = await clonedResponse.text();
    if (isEdgeBlock(bodyText)) {
      return response;
    }

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

// A REQUEST_BLOCKED JSON body, or the edge's HTML "Request blocked." page.
function isEdgeBlock(bodyText: string): boolean {
  try {
    const parsed = JSON.parse(bodyText) as { code?: unknown; error?: unknown };
    const nested = typeof parsed.error === "object" && parsed.error !== null ? (parsed.error as { code?: unknown }) : {};
    return parsed.code === "REQUEST_BLOCKED" || nested.code === "REQUEST_BLOCKED";
  } catch {
    return /request blocked/i.test(bodyText) && /<html|<!doctype/i.test(bodyText);
  }
}

export const responseInterceptors: ResponseInterceptor[] = [
  authenticationErrorInterceptor,
];

