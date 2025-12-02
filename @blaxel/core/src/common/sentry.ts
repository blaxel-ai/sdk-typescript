import { settings } from "./settings.js";
import * as Sentry from "@sentry/node";
import { makeNodeTransport } from "@sentry/node";

// Isolated Sentry client for SDK-only error tracking (doesn't interfere with user's Sentry)
let sentryClient: Sentry.NodeClient | null = null;
const capturedExceptions = new Set<string>();
let handlersRegistered = false;

// SDK path patterns to identify errors originating from our SDK
const SDK_PATTERNS = [
  "@blaxel/",
  "blaxel-sdk",
  "/node_modules/@blaxel/",
  "/@blaxel/core/",
  "/@blaxel/telemetry/",
];

/**
 * Check if an error originated from the SDK based on its stack trace.
 * Returns true if the stack trace contains any SDK-related paths.
 */
function isFromSDK(error: Error): boolean {
  const stack = error.stack || "";
  return SDK_PATTERNS.some((pattern) => stack.includes(pattern));
}

/**
 * Initialize an isolated Sentry client for SDK error tracking.
 * This creates a separate Sentry instance that won't interfere with any
 * Sentry configuration the user might have in their application.
 */
export function initSentry() {
  try {
    const dsn = settings.sentryDsn;

    if (!dsn) {
      return;
    }

    // Create an isolated Sentry client that doesn't touch the global scope
    // This allows users to have their own Sentry.init() without conflicts
    sentryClient = new Sentry.NodeClient({
      dsn,
      environment: settings.env,
      release: `sdk-typescript@${settings.version}`,
      transport: makeNodeTransport,
      stackParser: Sentry.defaultStackParser,
      // No integrations - we handle error capturing manually
      integrations: [],
      // Disable traces for the SDK client
      tracesSampleRate: 0,
      // Filter errors before sending - only send SDK errors
      beforeSend(event, hint) {
        if (event.environment !== 'dev' && event.environment !== 'prod') {
          return null;
        }
        const error = hint.originalException;
        if (error instanceof Error) {
          if (!isFromSDK(error)) {
            // Drop errors that don't originate from SDK
            return null;
          }
        }
        return event;
      },
    });
    sentryClient.init();

    // Set SDK-specific tags
    const scope = new Sentry.Scope();
    scope.setTag("blaxel.workspace", settings.workspace);
    scope.setTag("blaxel.version", settings.version);
    scope.setTag("blaxel.commit", settings.commit);
    scope.setClient(sentryClient);

    // Register process handlers for uncaught errors (Node.js only)
    // Only register once to prevent memory leaks
    if (
      typeof process !== "undefined" &&
      typeof process.on === "function" &&
      !handlersRegistered
    ) {
      handlersRegistered = true;

      // For SIGTERM/SIGINT, flush before exit
      const signalHandler = (signal: NodeJS.Signals) => {
        flushSentry(500)
          .catch(() => {
            // Silently fail
          })
          .finally(() => {
            process.exit(signal === "SIGTERM" ? 143 : 130);
          });
      };

      // Uncaught exception handler - only capture SDK errors
      const uncaughtExceptionHandler = (error: Error) => {
        if (isFromSDK(error)) {
          captureException(error);
        }
        // Let the default Node.js behavior handle the process exit
      };

      // Unhandled rejection handler - only capture SDK errors
      const unhandledRejectionHandler = (reason: unknown) => {
        const error =
          reason instanceof Error ? reason : new Error(String(reason));
        if (isFromSDK(error)) {
          captureException(error);
        }
      };

      process.on("SIGTERM", () => signalHandler("SIGTERM"));
      process.on("SIGINT", () => signalHandler("SIGINT"));
      process.on("uncaughtException", uncaughtExceptionHandler);
      process.on("unhandledRejection", unhandledRejectionHandler);

      // Intercept console.error to capture SDK errors that are caught and logged
      const originalConsoleError = console.error;
      console.error = function (...args: unknown[]) {
        // Call the original console.error first
        originalConsoleError.apply(console, args);

        // Check if any argument is an Error from SDK and capture it
        for (const arg of args) {
          if (arg instanceof Error && isFromSDK(arg)) {
            captureException(arg);
            break; // Only capture the first SDK error to avoid duplicates
          }
        }
      };
    }
  } catch (error) {
    // Silently fail - Sentry initialization should never break the SDK
    if (settings.env !== "production") {
      console.error("[Blaxel SDK] Error initializing Sentry:", error);
    }
  }
}

/**
 * Capture an exception to the SDK's isolated Sentry client.
 * Only errors originating from SDK code will be captured.
 *
 * @param error - The error to capture
 */
function captureException(error: Error): void {
  if (sentryClient === null) {
    return;
  }

  // Double-check that error is from SDK (defense in depth)
  if (!isFromSDK(error)) {
    return;
  }

  try {
    // Create a unique identifier for this exception to avoid duplicates
    const errorKey = `${error.name}:${error.message}:${error.stack?.slice(0, 200)}`;

    if (capturedExceptions.has(errorKey)) {
      return;
    }

    capturedExceptions.add(errorKey);

    // Clean up old exception keys to prevent memory leak
    if (capturedExceptions.size > 1000) {
      capturedExceptions.clear();
    }

    // Create a scope with SDK tags and capture the exception
    const scope = new Sentry.Scope();
    scope.setTag("blaxel.workspace", settings.workspace);
    scope.setTag("blaxel.version", settings.version);
    scope.setTag("blaxel.commit", settings.commit);
    scope.setClient(sentryClient);

    scope.captureException(error);
  } catch {
    // Silently fail - error capturing should never break the SDK
  }
}

/**
 * Flush pending Sentry events.
 * This should be called before the process exits to ensure all events are sent.
 *
 * @param timeout - Maximum time in milliseconds to wait for flush (default: 2000)
 */
export async function flushSentry(timeout = 2000): Promise<void> {
  if (sentryClient === null) {
    return;
  }

  try {
    await sentryClient.flush(timeout);
  } catch {
    // Silently fail
  }
}

/**
 * Check if Sentry is initialized and available.
 */
export function isSentryInitialized(): boolean {
  return sentryClient !== null;
}
