import http2 from "http2";
import { settings } from "./settings.js";
import type { H2Pool } from "./h2pool.js";
import { refH2SessionForActiveRequest } from "./h2ref.js";

type H2SendOptions = {
  onH2RequestCreated?: () => void;
  /**
   * Release the per-domain concurrency slot acquired by the pool-backed
   * wrappers. The H2 send path owns this once a request is handed to it: the
   * slot is held for the OPEN-STREAM lifetime (the same lifetime as the h2ref
   * active-request ref) and freed from `cleanupActiveRequest()` on every
   * terminal path, or — for a pre-flight fallback that never opens a stream on
   * the shared session — released immediately before falling back to
   * `globalThis.fetch`. Idempotent (see `acquireH2Slot`); defaults to a no-op
   * for the non-pool transports (`createH2Fetch` / `h2RequestDirect`).
   */
  releaseSlot?: () => void;
};

const MIN_H2_SESSION_MAX_LISTENERS = 64;
const sessionsWithListenerBudget = new WeakSet<http2.ClientHttp2Session>();

/**
 * Per-domain async semaphore that bounds the number of in-flight HTTP/2
 * requests against a single edge domain (one H2 session). The cap is keyed
 * by domain so throttling one sandbox's uploads never blocks requests to an
 * unrelated sandbox served by a different edge.
 *
 * When `settings.maxConcurrentH2Requests` is `0`/unset the gate is a no-op
 * (current default behavior: unlimited concurrency).
 */

// Last-resort leak guard for a held slot. The slot is now released on the real
// stream terminal (end / error / abort / cancel / pre-response reject), which
// always fires, so this timer is a pure backstop for the one residual case: a
// request that never opens a stream AND never settles (no response, no error,
// no abort) — it must not pin a slot forever and starve the per-domain queue.
//
// When it fires it ONLY frees the queue slot. It NEVER aborts or cancels the
// underlying request or its response stream: `release` does not touch `req` or
// the body stream, so a long-lived streaming response keeps flowing. Raised
// well beyond any legitimate stream lifetime so it cannot interfere with a
// healthy long-open stream (process.streamLogs / execWithStreaming / port
// proxy). RESIDUAL: a stream that outlives this backstop would have its slot
// freed early (the queue could then admit one extra stream); acceptable as a
// pure backstop, since the slot is otherwise tied to the true stream terminal.
const H2_SLOT_TIMEOUT_MS = 1_800_000; // 30 minutes

type H2DomainGate = {
  active: number;
  queue: Array<() => void>;
};

const h2GatesByDomain = new Map<string, H2DomainGate>();

function getH2Gate(domain: string): H2DomainGate {
  let gate = h2GatesByDomain.get(domain);
  if (!gate) {
    gate = { active: 0, queue: [] };
    h2GatesByDomain.set(domain, gate);
  }
  return gate;
}

/**
 * Acquire an OPEN-STREAM slot for `domain`. Resolves with a release function
 * that is idempotent and FIFO-fair: releasing wakes the longest-waiting queued
 * caller for the same domain. The slot is held for the lifetime of an OPEN H2
 * stream — the send path releases it on the stream terminal — so the gate
 * bounds true concurrent streams on the one shared session, not merely requests
 * awaiting headers (ENG-2678). A backstop timer releases the slot if a request
 * neither opens a stream nor ever settles, preventing per-domain starvation;
 * it never aborts the underlying request (see `H2_SLOT_TIMEOUT_MS`).
 */
async function acquireH2Slot(domain: string): Promise<() => void> {
  const max = settings.maxConcurrentH2Requests; // 0/undefined = unlimited
  if (!max || max <= 0) return () => {};

  const gate = getH2Gate(domain);
  while (gate.active >= max) {
    await new Promise<void>((resolve) => gate.queue.push(resolve));
  }
  gate.active++;

  let released = false;
  // Holder so `release` can clear the safety timer that is created after it.
  const timer: { handle?: ReturnType<typeof setTimeout> } = {};
  const release = () => {
    if (released) return;
    released = true;
    if (timer.handle !== undefined) clearTimeout(timer.handle);
    gate.active--;
    const next = gate.queue.shift();
    if (next) {
      next();
    } else if (gate.active === 0 && gate.queue.length === 0) {
      // No active requests and nothing waiting: drop the empty gate so the
      // Map does not grow unbounded across many short-lived domains.
      h2GatesByDomain.delete(domain);
    }
  };

  timer.handle = setTimeout(release, H2_SLOT_TIMEOUT_MS);
  // unref() so a pending safety timer never keeps the process alive. Guarded
  // because not every runtime's timer handle exposes unref().
  (timer.handle as unknown as { unref?: () => void }).unref?.();

  return release;
}

/**
 * Creates a fetch()-compatible function that sends requests over an existing
 * HTTP/2 session. Falls back to globalThis.fetch() only when the session is
 * closed/destroyed at call time (pre-flight, nothing sent on the wire).
 *
 * Any failure after session.request() succeeds propagates to the caller:
 * this transport never retries. Retry and timeout policy are caller concerns.
 */
export function createH2Fetch(
  session: http2.ClientHttp2Session,
): (input: Request) => Promise<Response> {
  return (input: Request): Promise<Response> => {
    if (session.closed || session.destroyed) {
      return globalThis.fetch(input);
    }
    return _h2Request(session, input);
  };
}

/**
 * Creates a fetch()-compatible function backed by the H2 session pool.
 *
 * The pool validates idle sessions before reuse. If no usable H2 session is
 * available, the request falls back to regular fetch before any H2 frames
 * are sent.
 */
export function createPoolBackedH2Fetch(
  pool: H2Pool,
  domain: string,
): (input: Request) => Promise<Response> {
  return async (input: Request): Promise<Response> => {
    // Acquire the slot here, but hand its release to the send path: it is held
    // for the OPEN-STREAM lifetime and freed on the stream terminal. Paths that
    // never open a stream on the shared session (fetch fallbacks go over a
    // different connection) release it immediately so they do not count against
    // the open-stream budget. `rel` is idempotent, so the explicit releases
    // below are safe even though the send path may also release.
    const rel = await acquireH2Slot(domain);
    try {
      const session = await pool.get(domain);
      if (session) {
        let h2RequestCreated = false;
        try {
          return await _h2Request(session, input, {
            onH2RequestCreated: () => {
              h2RequestCreated = true;
            },
            releaseSlot: rel,
          });
        } catch (err) {
          if (h2RequestCreated) {
            pool.evictSession(domain, session);
          }
          throw err;
        }
      }
      // No usable session: this fetch does not open a stream on the shared
      // session, so free the slot before falling back.
      rel();
      return await globalThis.fetch(input);
    } catch (err) {
      // Pre-send throw (e.g. pool.get() or Request body read): release the slot
      // so a failed request never pins it. Idempotent if already released.
      rel();
      throw err;
    }
  };
}

export async function h2RequestDirectFromPool(
  pool: H2Pool,
  domain: string,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  // See createPoolBackedH2Fetch: the slot is held for the OPEN-STREAM lifetime
  // and released by the send path on the stream terminal; non-stream fallbacks
  // release it immediately. `rel` is idempotent.
  const rel = await acquireH2Slot(domain);
  try {
    const session = await pool.get(domain);
    if (session) {
      let h2RequestCreated = false;
      try {
        return await h2RequestDirectInternal(session, url, init, {
          onH2RequestCreated: () => {
            h2RequestCreated = true;
          },
          releaseSlot: rel,
        });
      } catch (err) {
        if (h2RequestCreated) {
          pool.evictSession(domain, session);
        }
        throw err;
      }
    }
    // No usable session: fetch over a different connection, no stream opened.
    rel();
    return await globalThis.fetch(url, init);
  } catch (err) {
    rel();
    throw err;
  }
}

/**
 * Low-level H2 request that takes raw URL + init, skipping Request construction.
 * Used by SandboxAction.h2Fetch() for direct calls from subsystems.
 */
export function h2RequestDirect(
  session: http2.ClientHttp2Session,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  return h2RequestDirectInternal(session, url, init);
}

function h2RequestDirectInternal(
  session: http2.ClientHttp2Session,
  url: string,
  init?: RequestInit,
  options?: H2SendOptions,
): Promise<Response> {
  if (session.closed || session.destroyed) {
    // Pre-flight fallback (session unusable): no stream opens on the shared
    // session, so free any held slot before going over globalThis.fetch.
    options?.releaseSlot?.();
    return globalThis.fetch(url, init);
  }

  const parsed = new URL(url);
  const method = init?.method || "GET";
  const h2Headers: http2.OutgoingHttpHeaders = {
    ":method": method,
    ":path": parsed.pathname + parsed.search,
    ":authority": parsed.host,
  };

  if (init?.headers) {
    const entries = init.headers instanceof Headers
      ? init.headers.entries()
      : Array.isArray(init.headers)
        ? (init.headers as [string, string][]).values()
        : Object.entries(init.headers as Record<string, string>).values();
    for (const [key, value] of entries) {
      const k = key.toLowerCase();
      if (k === "host") continue;
      h2Headers[k] = value;
    }
  }

  let body: Buffer | undefined;
  if (init?.body) {
    if (typeof init.body === "string") {
      body = Buffer.from(init.body);
    } else if (Buffer.isBuffer(init.body)) {
      body = init.body;
    } else if (init.body instanceof ArrayBuffer) {
      body = Buffer.from(init.body);
    } else if (init.body instanceof Uint8Array) {
      body = Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength);
    } else {
      // FormData, ReadableStream, Blob, etc. can't be serialized to Buffer
      // for manual H2 framing — fall back to regular fetch (pre-flight,
      // nothing has been sent on the wire yet). No stream opens on the shared
      // session, so free any held slot before falling back.
      options?.releaseSlot?.();
      return globalThis.fetch(url, init);
    }
    if (!h2Headers["content-length"]) {
      h2Headers["content-length"] = body.byteLength;
    }
  }

  return _h2Send(session, h2Headers, body, init?.signal ?? null, url, init, options);
}

async function _h2Request(
  session: http2.ClientHttp2Session,
  input: Request,
  options?: H2SendOptions,
): Promise<Response> {
  const url = new URL(input.url);
  const method = input.method || "GET";

  const h2Headers: http2.OutgoingHttpHeaders = {
    ":method": method,
    ":path": url.pathname + url.search,
    ":authority": url.host,
  };

  for (const [key, value] of input.headers.entries()) {
    if (key === "host") continue;
    h2Headers[key] = value;
  }

  let body: Buffer | undefined;
  if (input.body) {
    body = Buffer.from(await input.arrayBuffer());
    if (!h2Headers["content-length"]) {
      h2Headers["content-length"] = body.byteLength;
    }
  }

  return _h2Send(
    session,
    h2Headers,
    body,
    input.signal,
    input.url,
    {
      method,
      headers: input.headers,
      body,
      signal: input.signal,
    },
    options,
  );
}

function _h2Send(
  session: http2.ClientHttp2Session,
  h2Headers: http2.OutgoingHttpHeaders,
  body: Buffer | undefined,
  signal: AbortSignal | null,
  fallbackUrl: string,
  fallbackInit?: RequestInit,
  options?: H2SendOptions,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let responded = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let streamClosed = false;
    let req: http2.ClientHttp2Stream | null = null;
    let releaseSessionRef = () => {};
    // The per-domain open-stream slot (idempotent; no-op for the non-pool
    // transports). Held for the OPEN-STREAM lifetime and released alongside the
    // session ref from cleanupActiveRequest() on every terminal path.
    const releaseSlot = options?.releaseSlot ?? (() => {});
    let abort: (() => void) | null = null;

    try {
      req = session.request(h2Headers);
    } catch {
      // Pre-flight fallback: session.request() threw synchronously, so no
      // H2 frames were sent. No stream opened on the shared session, so free
      // the slot before retrying over globalThis.fetch.
      releaseSlot();
      globalThis.fetch(fallbackUrl, fallbackInit).then(resolve, reject);
      return;
    }
    releaseSessionRef = refH2SessionForActiveRequest(session);
    options?.onH2RequestCreated?.();
    ensureH2SessionListenerBudget(session);

    const cleanupBeforeResponseListeners = () => {
      session.off("close", onSessionClose);
      session.off("goaway", onSessionGoaway);
      session.off("error", onSessionError);
    };

    const cleanupActiveRequest = () => {
      if (abort) signal?.removeEventListener("abort", abort);
      // Slot and session-ref share the OPEN-STREAM lifetime but stay
      // independent and each idempotent (PM-2160). Every terminal path funnels
      // through here exactly once: pre-response reject (close/goaway/error),
      // abort-before-response, abort-during-stream, stream end, stream error,
      // and ReadableStream cancel — so the slot is freed once on each.
      releaseSessionRef();
      releaseSlot();
    };

    const rejectBeforeResponse = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupBeforeResponseListeners();
      cleanupActiveRequest();
      req?.close();
      reject(err);
    };

    const onSessionClose = () => {
      rejectBeforeResponse(new Error("HTTP/2 session closed before response"));
    };
    const onSessionGoaway = () => {
      rejectBeforeResponse(new Error("HTTP/2 session sent GOAWAY before response"));
    };
    const onSessionError = (err: Error) => {
      rejectBeforeResponse(err);
    };

    session.once("close", onSessionClose);
    session.once("goaway", onSessionGoaway);
    session.once("error", onSessionError);

    abort = () => {
      req?.close();
      const abortError = new DOMException("The operation was aborted.", "AbortError");
      if (!responded) {
        if (!settled) {
          settled = true;
          cleanupBeforeResponseListeners();
          cleanupActiveRequest();
          reject(abortError);
        }
        return;
      }
      if (!streamClosed) {
        streamClosed = true;
        cleanupActiveRequest();
        streamController?.error(abortError);
      }
    };

    if (signal) {
      if (signal.aborted) {
        req.close();
        cleanupBeforeResponseListeners();
        settled = true;
        cleanupActiveRequest();
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    }

    req.on("response", (headers) => {
      if (settled) return;
      settled = true;
      responded = true;
      cleanupBeforeResponseListeners();

      const status = (headers[":status"] as number) ?? 200;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(headers)) {
        if (k.startsWith(":")) continue;
        if (v === undefined) continue;
        resHeaders.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      }

      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          const finishStream = (
            finish: () => void,
          ) => {
            if (streamClosed) return;
            streamClosed = true;
            cleanupActiveRequest();
            finish();
          };
          req.on("data", (chunk: Buffer) => {
            if (!streamClosed) controller.enqueue(new Uint8Array(chunk));
          });
          req.on("end", () => {
            finishStream(() => controller.close());
          });
          req.on("error", (err) => {
            finishStream(() => controller.error(err));
          });
        },
        cancel() {
          req?.close();
          if (streamClosed) return;
          streamClosed = true;
          cleanupActiveRequest();
        },
      });
      resolve(new Response(readable, { status, headers: resHeaders }));
    });

    req.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupBeforeResponseListeners();
      cleanupActiveRequest();
      reject(err);
    });

    if (body) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

function ensureH2SessionListenerBudget(session: http2.ClientHttp2Session): void {
  if (sessionsWithListenerBudget.has(session)) return;
  sessionsWithListenerBudget.add(session);

  const currentMax = session.getMaxListeners();
  if (currentMax > 0 && currentMax < MIN_H2_SESSION_MAX_LISTENERS) {
    session.setMaxListeners(MIN_H2_SESSION_MAX_LISTENERS);
  }
}
