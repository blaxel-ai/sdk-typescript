import dns from "dns/promises";
import http2 from "http2";
import tls from "tls";
import { markH2SessionIdleUnref } from "./h2ref.js";
import { settings } from "./settings.js";

export async function establishH2(sniHostname: string): Promise<http2.ClientHttp2Session> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("H2 warm-up timed out"));
    }, 5000);
  });

  const attempt = _establishH2(sniHostname).then((session) => {
    // If the timeout already fired, destroy the orphaned session immediately
    if (timedOut) {
      session.destroy();
    }
    return session;
  });

  return Promise.race([attempt, timeout]).finally(() => clearTimeout(timer));
}

// Round-robin cursor per hostname so successive warm connections to the same
// edge domain (the multi-session pool) land on different resolved addresses.
// Everything behind CloudFront terminates the same cert, so we keep the SNI
// servername fixed and only vary the dialed IP — spreading connections across
// edge PoPs / proxies instead of pinning every session to the first A record.
const addressCursor = new Map<string, number>();

async function resolveRotatingAddress(hostname: string): Promise<string> {
  try {
    const records = await dns.lookup(hostname, { all: true });
    if (records.length > 0) {
      const i = (addressCursor.get(hostname) ?? 0) % records.length;
      addressCursor.set(hostname, i + 1);
      return records[i].address;
    }
  } catch {
    // fall through to single lookup below
  }
  return (await dns.lookup(hostname)).address;
}

async function _establishH2(sniHostname: string): Promise<http2.ClientHttp2Session> {
  const address = await resolveRotatingAddress(sniHostname);

  const tlsSocket = tls.connect({
    host: address,
    port: 443,
    servername: sniHostname,
    ALPNProtocols: ["h2"],
  });

  // Raise the per-stream receive window (SETTINGS_INITIAL_WINDOW_SIZE) well above
  // Node's 64KB default. With the default, the server can only send one 64KB
  // burst per round trip, capping a single download at window/RTT (~3MB/s at
  // 20ms RTT) no matter the payload size.
  const session = http2.connect(`https://${sniHostname}:443`, {
    createConnection: () => tlsSocket,
    settings: { initialWindowSize: settings.h2StreamWindowSize },
  });

  await new Promise<void>((resolve, reject) => {
    session.on("connect", resolve);
    session.on("error", (err) => {
      // Ensure the TLS socket is cleaned up on connection error
      if (!tlsSocket.destroyed) tlsSocket.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  // Raise the connection-level receive window too. Node defaults it to 64KB and
  // never grows it, so it throttles the entire session (shared across every
  // stream) — which is why adding read concurrency does not help. setLocalWindowSize
  // is best-effort: guard it so an older runtime without it never breaks warm-up.
  try {
    (session as unknown as { setLocalWindowSize?: (n: number) => void })
      .setLocalWindowSize?.(settings.h2ConnectionWindowSize);
  } catch {
    // ignore — fall back to the default window
  }

  // Complete the SETTINGS exchange so the first real request has zero
  // protocol overhead. This RTT is hidden by the parallel createSandbox() call.
  await new Promise<void>((resolve) => session.ping(() => resolve()));

  // Unref so the idle session doesn't prevent process exit.
  markH2SessionIdleUnref(session);

  return session;
}
