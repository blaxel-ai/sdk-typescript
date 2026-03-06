import dns from "dns/promises";
import http2 from "http2";
import tls from "tls";

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

async function _establishH2(sniHostname: string): Promise<http2.ClientHttp2Session> {
  const { address } = await dns.lookup(sniHostname);

  const tlsSocket = tls.connect({
    host: address,
    port: 443,
    servername: sniHostname,
    ALPNProtocols: ["h2"],
  });

  const session = http2.connect(`https://${sniHostname}:443`, {
    createConnection: () => tlsSocket,
  });

  await new Promise<void>((resolve, reject) => {
    session.on("connect", resolve);
    session.on("error", (err) => {
      // Ensure the TLS socket is cleaned up on connection error
      if (!tlsSocket.destroyed) tlsSocket.destroy();
      reject(err);
    });
  });

  // Complete the SETTINGS exchange so the first real request has zero
  // protocol overhead. This RTT is hidden by the parallel createSandbox() call.
  await new Promise<void>((resolve) => session.ping(() => resolve()));

  // Unref so the session doesn't prevent process exit
  session.unref();

  return session;
}
