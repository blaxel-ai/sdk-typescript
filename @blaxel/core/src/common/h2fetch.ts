import http2 from "http2";
import type { h2Pool as H2PoolType } from "./h2pool.js";

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
 * Non-blocking: checks the pool cache synchronously. If a warm session is
 * available it's used immediately; otherwise the request goes through
 * regular fetch with zero delay (the pool keeps warming in the background
 * so subsequent calls get H2).
 */
export function createPoolBackedH2Fetch(
  pool: typeof H2PoolType,
  domain: string,
): (input: Request) => Promise<Response> {
  return (input: Request): Promise<Response> => {
    const session = pool.tryGet(domain);
    if (session) {
      return _h2Request(session, input);
    }
    return globalThis.fetch(input);
  };
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
  if (session.closed || session.destroyed) {
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
      // nothing has been sent on the wire yet).
      return globalThis.fetch(url, init);
    }
    if (!h2Headers["content-length"]) {
      h2Headers["content-length"] = body.byteLength;
    }
  }

  return _h2Send(session, h2Headers, body, init?.signal ?? null, url, init);
}

async function _h2Request(
  session: http2.ClientHttp2Session,
  input: Request,
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

  return _h2Send(session, h2Headers, body, input.signal, input.url, {
    method,
    headers: input.headers,
    body,
    signal: input.signal,
  });
}

function _h2Send(
  session: http2.ClientHttp2Session,
  h2Headers: http2.OutgoingHttpHeaders,
  body: Buffer | undefined,
  signal: AbortSignal | null,
  fallbackUrl: string,
  fallbackInit?: RequestInit,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let responded = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let streamClosed = false;

    let req: http2.ClientHttp2Stream;
    try {
      req = session.request(h2Headers);
    } catch {
      // Pre-flight fallback: session.request() threw synchronously, so no
      // H2 frames were sent. Safe to retry over globalThis.fetch.
      globalThis.fetch(fallbackUrl, fallbackInit).then(resolve, reject);
      return;
    }

    const abort = () => {
      req.close();
      const abortError = new DOMException("The operation was aborted.", "AbortError");
      if (!responded) {
        if (!settled) {
          settled = true;
          reject(abortError);
        }
        return;
      }
      if (!streamClosed) {
        streamClosed = true;
        streamController?.error(abortError);
      }
    };

    if (signal) {
      if (signal.aborted) {
        req.close();
        settled = true;
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    }

    req.on("response", (headers) => {
      if (settled) return;
      settled = true;
      responded = true;

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
          req.on("data", (chunk: Buffer) => {
            if (!streamClosed) controller.enqueue(new Uint8Array(chunk));
          });
          req.on("end", () => {
            if (!streamClosed) {
              streamClosed = true;
              controller.close();
            }
          });
          req.on("error", (err) => {
            if (!streamClosed) {
              streamClosed = true;
              controller.error(err);
            }
          });
        },
      });
      resolve(new Response(readable, { status, headers: resHeaders }));
    });

    req.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    if (body) {
      req.end(body);
    } else {
      req.end();
    }
  });
}
