import { settings } from "./settings.js";

// Lightweight Sentry client using fetch - only captures SDK errors
let sentryInitialized = false;
const capturedExceptions = new Set<string>();
let handlersRegistered = false;

// Parsed DSN components
let sentryConfig: {
  publicKey: string;
  host: string;
  projectId: string;
} | null = null;

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
 * Parse a Sentry DSN into its components.
 * DSN format: https://{public_key}@{host}/{project_id}
 */
function parseDsn(dsn: string): typeof sentryConfig {
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const host = url.host;
    const projectId = url.pathname.slice(1); // Remove leading slash

    if (!publicKey || !host || !projectId) {
      return null;
    }

    return { publicKey, host, projectId };
  } catch {
    return null;
  }
}

/**
 * Generate a UUID v4
 */
function generateEventId(): string {
  return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Convert an Error to a Sentry event payload.
 */
function errorToSentryEvent(error: Error): Record<string, unknown> {
  const frames = parseStackTrace(error.stack || "");

  return {
    event_id: generateEventId(),
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: "error",
    environment: settings.env,
    release: `sdk-typescript@${settings.version}`,
    tags: {
      "blaxel.workspace": settings.workspace,
      "blaxel.version": settings.version,
      "blaxel.commit": settings.commit,
    },
    exception: {
      values: [
        {
          type: error.name,
          value: error.message,
          stacktrace: {
            frames,
          },
        },
      ],
    },
  };
}

/**
 * Parse a stack trace string into Sentry-compatible frames.
 */
function parseStackTrace(
  stack: string
): Array<{ filename: string; function: string; lineno?: number; colno?: number }> {
  const lines = stack.split("\n").slice(1); // Skip first line (error message)
  const frames: Array<{ filename: string; function: string; lineno?: number; colno?: number }> = [];

  for (const line of lines) {
    // Match patterns like "at functionName (filename:line:col)" or "at filename:line:col"
    const match = line.match(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/);
    if (match) {
      frames.unshift({
        function: match[1] || "<anonymous>",
        filename: match[2],
        lineno: parseInt(match[3], 10),
        colno: parseInt(match[4], 10),
      });
    }
  }

  return frames;
}

/**
 * Send an event to Sentry using fetch.
 */
async function sendToSentry(event: Record<string, unknown>): Promise<void> {
  if (!sentryConfig) return;

  const { publicKey, host, projectId } = sentryConfig;
  const envelopeUrl = `https://${host}/api/${projectId}/envelope/`;

  // Create envelope header
  const envelopeHeader = JSON.stringify({
    event_id: event.event_id,
    sent_at: new Date().toISOString(),
    dsn: `https://${publicKey}@${host}/${projectId}`,
  });

  // Create item header
  const itemHeader = JSON.stringify({
    type: "event",
    content_type: "application/json",
  });

  // Create envelope body
  const envelope = `${envelopeHeader}\n${itemHeader}\n${JSON.stringify(event)}`;

  try {
    await fetch(envelopeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=blaxel-sdk/${settings.version}, sentry_key=${publicKey}`,
      },
      body: envelope,
    });
  } catch {
    // Silently fail - error reporting should never break the SDK
  }
}

// Queue for pending events
const pendingEvents: Array<Record<string, unknown>> = [];
let flushPromise: Promise<void> | null = null;

/**
 * Register browser/edge environment error handlers.
 * Separated to isolate dynamic globalThis access.
 */
function registerBrowserHandlers(): void {
  const g = globalThis as Record<string, unknown>;
  if (g && typeof g.addEventListener === "function") {
    (g.addEventListener as (type: string, listener: (e: unknown) => void) => void)("error", (event: unknown) => {
      const e = event as { error?: unknown };
      if (e.error instanceof Error && isFromSDK(e.error)) {
        captureException(e.error);
      }
    });

    (g.addEventListener as (type: string, listener: (e: unknown) => void) => void)("unhandledrejection", (event: unknown) => {
      const e = event as { reason?: unknown };
      const error =
        e.reason instanceof Error ? e.reason : new Error(String(e.reason));
      if (isFromSDK(error)) {
        captureException(error);
      }
    });
  }
}

/**
 * Initialize the lightweight Sentry client for SDK error tracking.
 */
export function initSentry() {
  try {
    // Check if tracking is disabled
    if (!settings.tracking) {
      return;
    }

    const dsn = settings.sentryDsn;

    if (!dsn) {
      return;
    }

    // Parse DSN
    sentryConfig = parseDsn(dsn);
    if (!sentryConfig) {
      return;
    }

    // Only allow dev/prod environments
    if (settings.env !== "dev" && settings.env !== "prod") {
      return;
    }

    sentryInitialized = true;

    // Register error handlers only once
    if (!handlersRegistered) {
      handlersRegistered = true;

      // Node.js specific handlers
      if (typeof process !== "undefined" && typeof process.on === "function") {
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
          originalConsoleError.apply(console, args);
          for (const arg of args) {
            if (arg instanceof Error && isFromSDK(arg)) {
              captureException(arg);
              break;
            }
          }
        };
      } else {
        // Browser/Edge environment handlers
        registerBrowserHandlers();
      }
    }
  } catch (error) {
    // Silently fail - Sentry initialization should never break the SDK
    if (settings.env !== "production") {
      console.error("[Blaxel SDK] Error initializing Sentry:", error);
    }
  }
}

/**
 * Capture an exception to Sentry.
 * Only errors originating from SDK code will be captured.
 *
 * @param error - The error to capture
 */
function captureException(error: Error): void {
  if (!sentryInitialized || !sentryConfig) {
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

    // Convert error to Sentry event and queue it
    const event = errorToSentryEvent(error);
    pendingEvents.push(event);

    // Send immediately (fire and forget)
    sendToSentry(event).catch(() => {
      // Silently fail
    });
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
  if (!sentryInitialized || pendingEvents.length === 0) {
    return;
  }

  // If already flushing, wait for it
  if (flushPromise) {
    await flushPromise;
    return;
  }

  try {
    // Send all pending events
    const eventsToSend = [...pendingEvents];
    pendingEvents.length = 0;

    flushPromise = Promise.race([
      Promise.all(eventsToSend.map((event) => sendToSentry(event))).then(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, timeout)),
    ]);

    await flushPromise;
  } catch {
    // Silently fail
  } finally {
    flushPromise = null;
  }
}

/**
 * Check if Sentry is initialized and available.
 */
export function isSentryInitialized(): boolean {
  return sentryInitialized;
}
