/**
 * Controllable, in-process HTTP/2 fault-injection server.
 *
 * SCOPE: This harness exists to validate the CLIENT's RESPONSE to HTTP/2
 * protocol faults (the transport state machine + session lifecycle in
 * `@blaxel/core/src/common/h2fetch.ts`). It is a real `node:http2` secure
 * server over TLS+ALPN("h2"), so tests get an authentic `ClientHttp2Session`
 * to hand to `createH2Fetch()`. It does NOT contain Pingora's code and cannot
 * reproduce the real rapid-reset / ENHANCE_YOUR_CALM trigger. See README.md.
 *
 * No network egress: everything binds to 127.0.0.1 on an ephemeral port.
 */
import { execFileSync } from "node:child_process";
import http2 from "http2";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_STATUS,
  NGHTTP2_NO_ERROR,
} = http2.constants;

/** A recorded inbound request, captured for exactly-once assertions. */
export type RecordedRequest = {
  method: string;
  path: string;
  headers: http2.IncomingHttpHeaders;
  body: string;
  /** 1-based ordinal of this request across the server's lifetime. */
  index: number;
};

/**
 * Per-request fault behavior. A test sets these via `command()`; they apply to
 * subsequent requests until `reset()` or another `command()` overrides them.
 *
 * Numeric reset codes are accepted directly (e.g. `http2.constants
 * .NGHTTP2_ENHANCE_YOUR_CALM` === 11). All delays are real-timer based but kept
 * tiny (<=250ms) for determinism; control is otherwise event-driven.
 */
export type FaultCommand = {
  /** Send GOAWAY to the session after this many streams have been opened. */
  goawayAfterStreams?: number;
  /**
   * RST_STREAM the request stream instead of responding.
   * `{ code }` is an nghttp2 error code (e.g. NGHTTP2_ENHANCE_YOUR_CALM = 11).
   * If `forPaths` is given, ONLY requests whose `:path` is in that list are
   * RST'd; every other request gets the baseline 200 echo. This makes per-stream
   * isolation deterministic under concurrency (route by path, not arrival order).
   */
  rstStreamWith?: { code: number; forPaths?: string[] };
  /**
   * SETTINGS to advertise to the client (e.g. maxConcurrentStreams). Honored
   * from the INITIAL command passed to `startH2FaultServer` so it ships in the
   * server's first SETTINGS frame — the client then queues excess streams
   * rather than having them refused. Changing it later via `command()` does not
   * re-advertise on an already-connected session.
   */
  settings?: { maxConcurrentStreams?: number };
  /** Respond after this many milliseconds (models a slow POST). */
  delayResponseMs?: number;
  /** Destroy the underlying socket mid-flight instead of responding. */
  destroySocketMid?: boolean;
  /**
   * Send 200 headers + a first body chunk immediately, then HOLD the response
   * stream open for this many milliseconds before ending it. This leaves the
   * client's response body `ReadableStream` open after headers arrive, which is
   * the only way to exercise the abort-DURING-streaming branch of `_h2Send`
   * (the baseline echo ends the stream in the same tick, so there is no window).
   * The hold is bounded and the timer is tracked by `close()`, so it never leaks.
   */
  respondThenHoldBodyMs?: number;
};

export type StartH2FaultServerOptions = {
  /** Initial command applied to every request until overridden. */
  command?: FaultCommand;
};

export type H2FaultServer = {
  url: string;
  port: number;
  address: string;
  /** Connect a real client session (TLS, ALPN h2, rejectUnauthorized:false). */
  connectClient: () => http2.ClientHttp2Session;
  /** Every request the server has received, in arrival order. */
  requests: RecordedRequest[];
  /** Replace the active fault command (applies to subsequent requests). */
  command: (cmd: FaultCommand) => void;
  /** Clear fault state and the recorded-request log back to baseline echo. */
  reset: () => void;
  /** Shut the server down and free the listening handle. */
  close: () => Promise<void>;
};

let cachedTlsCert: { cert: Buffer; key: Buffer } | null = null;

/**
 * Generate a throwaway self-signed localhost cert at runtime (cached per
 * process). Test-only and deliberately NOT committed: a private key — even a
 * localhost test one — does not belong in the repo (it trips GitHub push
 * protection / secret scanners and is needless key material). Requires
 * `openssl` on PATH, present on macOS and the CI runners.
 */
function loadFixtures(): { cert: Buffer; key: Buffer } {
  if (cachedTlsCert) return cachedTlsCert;
  const dir = mkdtempSync(join(tmpdir(), "h2-fault-cert-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  cachedTlsCert = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  return cachedTlsCert;
}

/**
 * Start a controllable HTTP/2 fault server bound to 127.0.0.1 on an ephemeral
 * port. Resolves once the server is listening.
 */
export async function startH2FaultServer(
  opts: StartH2FaultServerOptions = {},
): Promise<H2FaultServer> {
  const { cert, key } = loadFixtures();
  const requests: RecordedRequest[] = [];
  let activeCommand: FaultCommand = opts.command ?? {};
  let streamsOpened = 0;
  // Track pending timers so close() can clear them and never leak handles.
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  // SETTINGS (e.g. maxConcurrentStreams) must be in the server's initial
  // SETTINGS frame so the client knows the cap BEFORE it issues requests and
  // queues excess streams. Advertising it after the fact only makes the server
  // RST_STREAM the overflow with REFUSED_STREAM, which is a different fault.
  // Honor the initial command's settings at construction; this is the
  // connection-level property tests assert against.
  const initialSettings: http2.Settings = {};
  if (opts.command?.settings?.maxConcurrentStreams !== undefined) {
    initialSettings.maxConcurrentStreams =
      opts.command.settings.maxConcurrentStreams;
  }

  const server = http2.createSecureServer({
    cert,
    key,
    ALPNProtocols: ["h2"],
    settings: initialSettings,
  });

  // Do not crash the test process on the faults we deliberately inject.
  server.on("error", () => {});
  server.on("sessionError", () => {});
  server.on("session", (session) => {
    session.on("error", () => {});
  });

  server.on("stream", (stream, headers) => {
    streamsOpened += 1;
    const myStreamOrdinal = streamsOpened;
    const cmd = activeCommand;

    const method = String(headers[HTTP2_HEADER_METHOD] ?? "GET");
    const path = String(headers[HTTP2_HEADER_PATH] ?? "/");

    // Buffer the request body so the echo baseline can return it verbatim and
    // exactly-once assertions can inspect what was actually sent.
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("error", () => {});

    stream.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const record: RecordedRequest = {
        method,
        path,
        headers,
        body,
        index: requests.length + 1,
      };
      requests.push(record);

      // GOAWAY-before-response: once enough streams have opened, tear the
      // session down without answering this stream.
      if (
        cmd.goawayAfterStreams !== undefined &&
        myStreamOrdinal >= cmd.goawayAfterStreams
      ) {
        stream.session?.goaway(NGHTTP2_NO_ERROR);
        return;
      }

      // RST_STREAM with an explicit nghttp2 code (e.g. ENHANCE_YOUR_CALM=11).
      // When `forPaths` is set, only matching paths are RST'd; the rest fall
      // through to the baseline 200 echo (per-stream isolation under load).
      if (
        cmd.rstStreamWith &&
        (cmd.rstStreamWith.forPaths === undefined ||
          cmd.rstStreamWith.forPaths.includes(path))
      ) {
        stream.close(cmd.rstStreamWith.code);
        return;
      }

      // Destroy the socket mid-flight (models an abrupt connection drop).
      if (cmd.destroySocketMid) {
        stream.session?.destroy();
        return;
      }

      // Stream headers + a first body chunk, then keep the response open for a
      // bounded window before ending. Lets a test abort while the client's
      // response body stream is still readable.
      if (cmd.respondThenHoldBodyMs && cmd.respondThenHoldBodyMs > 0) {
        if (stream.closed || stream.destroyed) return;
        stream.respond({
          [HTTP2_HEADER_STATUS]: 200,
          "content-type": "text/plain; charset=utf-8",
          "x-echo-method": method,
          "x-echo-path": path,
        });
        stream.write("chunk-1");
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          if (!stream.closed && !stream.destroyed) stream.end("chunk-2");
        }, cmd.respondThenHoldBodyMs);
        pendingTimers.add(timer);
        return;
      }

      const respond = () => {
        if (stream.closed || stream.destroyed) return;
        stream.respond({
          [HTTP2_HEADER_STATUS]: 200,
          "content-type": "text/plain; charset=utf-8",
          "x-echo-method": method,
          "x-echo-path": path,
        });
        // Baseline echoes the request body so tests can assert round-trip.
        stream.end(body);
      };

      if (cmd.delayResponseMs && cmd.delayResponseMs > 0) {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          respond();
        }, cmd.delayResponseMs);
        pendingTimers.add(timer);
        return;
      }

      respond();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addressInfo = server.address();
  if (addressInfo === null || typeof addressInfo === "string") {
    throw new Error("H2 fault server failed to bind to a TCP port");
  }
  const port = addressInfo.port;
  const address = "127.0.0.1";
  const url = `https://${address}:${port}`;

  const clientSessions = new Set<http2.ClientHttp2Session>();

  const connectClient = (): http2.ClientHttp2Session => {
    const session = http2.connect(url, {
      rejectUnauthorized: false,
      ALPNProtocols: ["h2"],
    });
    // Swallow client-side session errors caused by injected faults; the
    // transport-under-test installs its own listeners and rejects callers.
    session.on("error", () => {});
    clientSessions.add(session);
    session.once("close", () => clientSessions.delete(session));
    return session;
  };

  const command = (cmd: FaultCommand): void => {
    activeCommand = cmd;
  };

  const reset = (): void => {
    activeCommand = {};
    streamsOpened = 0;
    requests.length = 0;
  };

  const close = async (): Promise<void> => {
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    for (const session of clientSessions) {
      if (!session.closed && !session.destroyed) session.destroy();
    }
    clientSessions.clear();
    await new Promise<void>((resolve) => {
      // close() waits for open connections; destroy any stragglers so the
      // listening handle is released promptly and the test process exits.
      server.close(() => resolve());
      (server as unknown as { closeIdleConnections?: () => void })
        .closeIdleConnections?.();
    });
  };

  return {
    url,
    port,
    address,
    connectClient,
    requests,
    command,
    reset,
    close,
  };
}
