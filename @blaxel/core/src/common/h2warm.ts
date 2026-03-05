import dns from "dns/promises";
import http2 from "http2";
import tls from "tls";

export async function establishH2(sniHostname: string): Promise<http2.ClientHttp2Session> {
  const { address } = await dns.lookup(sniHostname);

export async function establishH2(sniHostname: string): Promise<http2.ClientHttp2Session> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("H2 warm-up timed out")), 5000)
  );
  return Promise.race([_establishH2(sniHostname), timeout]);
}

async function _establishH2(sniHostname: string): Promise<http2.ClientHttp2Session> {
  const { address } = await dns.lookup(sniHostname);

  const session = http2.connect(`https://${sniHostname}:443`, {
    createConnection: () =>
      tls.connect({
        host: address,
        port: 443,
        servername: sniHostname,
        ALPNProtocols: ["h2"],
      }),
  });

  await new Promise<void>((resolve, reject) => {
    session.on("connect", resolve);
    session.on("error", reject);
  });

  // Complete the SETTINGS exchange so the first real request has zero
  // protocol overhead. This RTT is hidden by the parallel createSandbox() call.
  await new Promise<void>((resolve) => session.ping(() => resolve()));

  // Unref so the session doesn't prevent process exit
  session.unref();

  return session;
}
