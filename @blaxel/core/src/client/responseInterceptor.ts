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
  authenticationErrorInterceptor,
];

