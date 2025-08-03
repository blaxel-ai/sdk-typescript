import { authenticate, settings } from "@blaxel/core";
import { APIResponse, FetchFunction, Fetcher } from "cohere-ai/core";

/**
 * Creates a custom fetcher for CohereClient that adds dynamic headers
 * CohereClient's fetcher expects a function that intercepts fetch requests
 */
export const createCohereFetcher = (): FetchFunction => {
  // Return a function that matches CohereClient's FetchFunction interface
  const fetcher: FetchFunction = async <R = unknown>(args: Fetcher.Args): Promise<APIResponse<R, Fetcher.Error>> => {
    await authenticate();
    const dynamicHeaders = settings.headers;

    // Extract all fields from args
    const {
      url,
      method,
      headers: argsHeaders,
      body,
      contentType,
      queryParameters,
      timeoutMs,
      withCredentials,
      abortSignal,
      requestType,
      responseType,
      duplex
    } = args;

    // Build URL with query parameters
    let requestUrl = url;
    if (queryParameters) {
      const params = new URLSearchParams();
      Object.entries(queryParameters).forEach(([key, value]) => {
        if (Array.isArray(value)) {
          value.forEach(v => {
            if (typeof v === 'object' && v !== null) {
              params.append(key, JSON.stringify(v));
            } else {
              params.append(key, String(v));
            }
          });
        } else if (typeof value === 'object' && value !== null) {
          params.append(key, JSON.stringify(value));
        } else {
          params.append(key, String(value));
        }
      });
      const queryString = params.toString();
      if (queryString) {
        requestUrl += (url.includes('?') ? '&' : '?') + queryString;
      }
    }

    // Merge headers and filter out undefined values
    const mergedHeaders: Record<string, string | undefined> = {
      ...(argsHeaders || {}),
      ...dynamicHeaders,
    };

    // Add content-type if specified
    if (contentType) {
      mergedHeaders['Content-Type'] = contentType;
    }

    // Filter out undefined values
    const headers: Record<string, string> = Object.entries(mergedHeaders).reduce(
      (acc, [key, value]) => {
        if (value !== undefined) {
          acc[key] = value;
        }
        return acc;
      },
      {} as Record<string, string>
    );

    // Prepare body based on requestType
    let requestBody: string | Blob | ArrayBuffer | FormData | ReadableStream | undefined;
    if (body !== undefined) {
      if (requestType === 'json' || !requestType) {
        requestBody = JSON.stringify(body);
      } else if (requestType === 'bytes' && body instanceof Uint8Array) {
        requestBody = body;
      } else if (requestType === 'file' && body instanceof Blob) {
        requestBody = body;
      } else if (typeof body === 'string') {
        requestBody = body;
      } else {
        requestBody = JSON.stringify(body);
      }
    }

    try {
      // Create abort controller for timeout
      const controller = new AbortController();
      let timeoutId: NodeJS.Timeout | undefined;

      if (timeoutMs) {
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      }

      // Merge abort signals
      const signal = abortSignal
        ? AbortSignal.any([abortSignal, controller.signal])
        : controller.signal;

      // Make the request with merged headers
      const requestInit: RequestInit & { duplex?: string } = {
        method: method,
        headers,
        body: requestBody,
        credentials: withCredentials ? 'include' : 'same-origin',
        signal,
      };

      // Add duplex if specified (for streaming)
      if (duplex) {
        requestInit.duplex = duplex;
      }

      const response = await fetch(requestUrl, requestInit);

      // Clear timeout
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // Handle response based on responseType
      let responseBody: any;
      if (response.ok) {
        if (responseType === 'blob') {
          responseBody = await response.blob();
        } else if (responseType === 'text') {
          responseBody = await response.text();
        } else if (responseType === 'arrayBuffer') {
          responseBody = await response.arrayBuffer();
        } else if (responseType === 'streaming' || responseType === 'sse') {
          // For streaming, return the response body stream
          responseBody = response.body;
        } else {
          // Default to JSON
          responseBody = await response.json();
        }

        // Return success response in the format CohereClient expects
        return {
          ok: true,
          body: responseBody as R,
          headers: Object.fromEntries(response.headers.entries()),
        };
      } else {
        // Return error response in the format CohereClient expects
        const errorBody = await response.text();
        return {
          ok: false,
          error: {
            reason: "status-code",
            statusCode: response.status,
            body: errorBody,
          },
        };
      }
    } catch (error) {
      // Check if it's a timeout error
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          ok: false,
          error: {
            reason: "timeout",
          },
        };
      }

      // Return unknown error
      return {
        ok: false,
        error: {
          reason: "unknown",
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };

  return fetcher;
};
