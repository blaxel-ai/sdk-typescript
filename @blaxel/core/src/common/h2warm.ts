import dns from "dns/promises";
import http2 from "http2";
import tls from "tls";

export async function establishH2(sniHostname: string): Promise<http2.ClientHttp2Session> {
  const { address } = await dns.lookup(sniHostname);

  const session = http2.connect(`https://${sniHostname}:443`, {
    createConnection: () =>
      tls.connect({
        host: address,
        port: 443,
        servername: sniHostname,
        rejectUnauthorized: false,
        ALPNProtocols: ["h2"],
      }),
  });

  await new Promise<void>((resolve, reject) => {
    session.on("connect", resolve);
    session.on("error", reject);
  });

  // Unref so the session doesn't prevent process exit
  session.unref();

  return session;
}
