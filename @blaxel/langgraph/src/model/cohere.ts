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
    // Rewrite /v1/chat to /v2/chat for Cohere API v2 compatibility
    let requestUrl = url.replace('/v1/chat', '/v2/chat');
    const isV2Endpoint = requestUrl.includes('/v2/chat');
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
        // Transform body for Cohere v2 API compatibility (only if using v2 endpoint)
        let transformedBody = body;
        if (isV2Endpoint && typeof body === 'object' && body !== null && !Array.isArray(body)) {
          const bodyObj = body as Record<string, unknown>;
          transformedBody = { ...bodyObj };
          const transformedObj = transformedBody as Record<string, unknown>;

          // Remove v1-only fields that are not supported in v2
          const fieldsToRemove = ['chat_history'];
          for (const field of fieldsToRemove) {
            if (field in transformedObj) {
              delete transformedObj[field];
            }
          }

          // Convert 'message' to 'messages' format if message exists and messages doesn't
          if ('message' in transformedObj && !('messages' in transformedObj)) {
            const message = transformedObj.message;
            if (typeof message === 'string' && message.trim().length > 0) {
              // Convert single message string to messages array format
              transformedObj.messages = [
                {
                  role: 'user',
                  content: message,
                },
              ];
            }
            // Remove the old message field
            delete transformedObj.message;
          }

          // Handle tool_results - v2 might use a different format, remove for now
          if ('tool_results' in transformedObj) {
            delete transformedObj.tool_results;
          }
        }
        requestBody = JSON.stringify(transformedBody);
      } else if (requestType === 'bytes' && body instanceof Uint8Array) {
        // Create a new ArrayBuffer from the Uint8Array to avoid SharedArrayBuffer issues
        const arrayBuffer = new ArrayBuffer(body.length);
        const view = new Uint8Array(arrayBuffer);
        view.set(body);
        requestBody = arrayBuffer;
      } else if (requestType === 'file' && body instanceof Blob) {
        requestBody = body;
      } else if (typeof body === 'string') {
        // Parse and transform JSON strings (only if using v2 endpoint)
        if (isV2Endpoint) {
          try {
            const parsed: unknown = JSON.parse(body);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
              interface RequestBody {
                chat_history?: unknown;
                tool_results?: unknown;
                message?: unknown;
                messages?: unknown;
                [key: string]: unknown;
              }
              const transformed: RequestBody = { ...parsed as Record<string, unknown> };

              // Remove v1-only fields
              if ('chat_history' in transformed) {
                delete transformed.chat_history;
              }
              if ('tool_results' in transformed) {
                delete transformed.tool_results;
              }

              // Convert 'message' to 'messages' format if message exists and messages doesn't
              if ('message' in transformed && !('messages' in transformed)) {
                const message = transformed.message;
                if (typeof message === 'string' && message.trim().length > 0) {
                  transformed.messages = [
                    {
                      role: 'user',
                      content: message,
                    },
                  ];
                }
                delete transformed.message;
              }

              requestBody = JSON.stringify(transformed);
            } else {
              requestBody = body;
            }
          } catch {
            requestBody = body;
          }
        } else {
          requestBody = body;
        }
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

          // Transform v2 response format to v1 format for ChatCohere compatibility
          if (isV2Endpoint && typeof responseBody === 'object' && responseBody !== null) {
            // Cohere v2 returns: { message: { role: "assistant", content: [...] }, ... }
            // ChatCohere expects: { text: "...", ... } or similar v1 format
            interface ResponseBody {
              message?: {
                role?: string;
                content?: unknown;
              };
              [key: string]: unknown;
            }
            const responseObj = responseBody as ResponseBody;
            if ('message' in responseObj && typeof responseObj.message === 'object' && responseObj.message !== null) {
              const v2Message = responseObj.message as { role?: string; content?: unknown };

              // Extract text from content array
              let text = '';
              if (Array.isArray(v2Message.content)) {
                // Type guard for content items
                interface ContentItem {
                  type?: string;
                  text?: string;
                  thinking?: string;
                }
                const contentArray = v2Message.content as ContentItem[];

                // Find the text content block
                const textBlock = contentArray.find(
                  (item) => item.type === 'text' && item.text
                );
                if (textBlock && textBlock.text) {
                  text = textBlock.text;
                } else {
                  // Fallback: join all text-like content
                  text = contentArray
                    .map((item) => item.text || item.thinking || '')
                    .filter(Boolean)
                    .join('\n');
                }
              } else if (typeof v2Message.content === 'string') {
                text = v2Message.content;
              }

              // Transform to v1-like format that ChatCohere expects
              const transformedResponse: Record<string, unknown> = {
                ...responseObj,
                text: text,
                // Keep the original message structure in case ChatCohere needs it
                message: responseObj.message,
              };

              responseBody = transformedResponse as R;
            }
          }
        }

        // Return success response in the format CohereClient expects
        return {
          ok: true,
          body: responseBody as R,
          headers: Object.fromEntries(response.headers.entries()),
        } as APIResponse<R, Fetcher.Error>;
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
        } as APIResponse<R, Fetcher.Error>;
      }
    } catch (error) {
      // Check if it's a timeout error
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          ok: false,
          error: {
            reason: "timeout",
          },
        } as APIResponse<R, Fetcher.Error>;
      }

      // Return unknown error
      return {
        ok: false,
        error: {
          reason: "unknown",
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      } as APIResponse<R, Fetcher.Error>;
    }
  };

  return fetcher;
};
