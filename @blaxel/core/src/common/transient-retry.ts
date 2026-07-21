import { settings } from "./settings.js";

// Markers that, when present anywhere in the error chain, are unambiguous
// signals of a transient HTTP/2 stream reset or connection drop. These are
// protocol/transport level codes, not application payloads, so substring
// matching them does not over-match a server-sent error body. Each entry is
// matched case-sensitively against the error message and its cause.
//
// Deliberately excluded: bare "INTERNAL_ERROR" and "fetch failed". Both are
// too generic on their own (an application 500 body or any failed fetch would
// match), so we only treat them as transient when paired with a transport
// error code on the cause (see isTransientResetError).
const TRANSIENT_RESET_MARKERS = [
  "ENHANCE_YOUR_CALM", // H2 flow-control backpressure reset
  "NGHTTP2_INTERNAL_ERROR", // H2 internal stream error (qualified form)
  "ERR_HTTP2", // node http2 error code family
  "GOAWAY", // peer is draining the connection
  "HTTP/2 session closed before response", // thrown by our own h2 transport
  "HTTP/2 session sent GOAWAY before response",
];

// Node-level error codes (from `error.code` / `error.cause.code`) that mean
// the connection itself dropped mid-flight and the request never completed.
// These are safe to retry for an idempotent request.
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_SESSION_ERROR",
]);

function collectErrorText(error: unknown): { messages: string[]; codes: string[] } {
  const messages: string[] = [];
  const codes: string[] = [];
  // Walk the error -> cause chain (bounded) so a transport error wrapped by a
  // higher-level "fetch failed" is still classified correctly.
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const node = current as { message?: unknown; code?: unknown; cause?: unknown };
    if (typeof node.message === "string") messages.push(node.message);
    if (typeof node.code === "string") codes.push(node.code);
    current = node.cause;
  }
  return { messages, codes };
}

// True when the error chain carries a real HTTP response (a status came back
// from the server). Such an error is an APPLICATION response — never a transport
// reset — even if the server's error body text happens to contain a reset marker
// like "GOAWAY" or "ERR_HTTP2". Guarding on this stops a marker-bearing 4xx/5xx
// body from being misread as transient and retried (the over-match Codex flagged
// for the now default-on idempotent-read retry).
function hasHttpResponseStatus(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const node = current as { status?: unknown; response?: { status?: unknown }; cause?: unknown };
    if (typeof node.status === "number") return true;
    if (node.response && typeof node.response === "object" &&
        typeof (node.response as { status?: unknown }).status === "number") {
      return true;
    }
    current = node.cause;
  }
  return false;
}

/**
 * True only for transport-level resets/drops that are safe to retry on an
 * IDEMPOTENT request (transient HTTP/2 stream reset, GOAWAY, or a dropped
 * connection). Application errors (4xx/5xx — even when their body text contains
 * a marker word) and a bare "fetch failed" with no transport code are
 * deliberately NOT transient, so auto-retry never masks a real server error or
 * duplicates a non-idempotent call.
 *
 * This is the single classifier shared by the upload-part retry (ENG-2680) and
 * the idempotent sandbox-op retry (read/list/etc.), so both judge "transient"
 * identically.
 */
export function isTransientResetError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  // An error that carries an HTTP response is an application error, not a
  // transport reset — never retry it on the strength of a marker in its body.
  if (hasHttpResponseStatus(error)) {
    return false;
  }
  const { messages, codes } = collectErrorText(error);

  // 1. An explicit transient transport error code anywhere in the chain.
  if (codes.some((code) => TRANSIENT_ERROR_CODES.has(code))) {
    return true;
  }

  // 2. An unambiguous protocol-level reset marker in any message.
  if (messages.some((text) =>
    TRANSIENT_RESET_MARKERS.some((marker) => text.includes(marker)),
  )) {
    return true;
  }

  return false;
}

const DEFAULT_BASE_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 2000;

// Exponential backoff with full-jitter on top of one base delay, capped so a
// single wait never blocks unreasonably long. Exponential (rather than linear)
// gives a later attempt room to span a multi-second sandbox cold-start/standby
// wake, which is the window a first-call reset falls into, while early attempts
// stay fast for the common quick-reset case. Exported so other polling paths
// (e.g. the create-504 wait in sandbox.ts) share the same delay curve.
export function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, maxDelayMs);
  const jitter = Math.floor(Math.random() * baseDelayMs);
  return capped + jitter;
}

export type RetryOptions = {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

/**
 * Run `fn`, retrying only on transient transport resets (see
 * isTransientResetError) with exponential backoff. Caller owns idempotency:
 * ONLY wrap idempotent operations (GET-shaped reads/lists, or an idempotent
 * PUT of the same bytes) — never a non-idempotent POST such as process.exec,
 * which would duplicate the side effect (ENG-2340).
 *
 * Defaults to `settings.sandboxReadRetries` (the higher idempotent-read budget,
 * sized for a multi-second standby wake). The upload path passes
 * `{ retries: settings.fsPartRetries }` to keep its own (lower) budget.
 */
export async function retryOnTransientReset<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? settings.sandboxReadRetries;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      if (retries <= 0 || attempt > retries || !isTransientResetError(error)) {
        throw error;
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, backoffDelayMs(attempt, baseDelayMs, maxDelayMs)),
      );
    }
  }
}
