import { SandboxInstance } from "@blaxel/core"
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultImage, defaultLabels, defaultRegion, uniqueName } from '../helpers.js'
import { createEchoServerSandbox, createReadyProxySandbox, execProxyCommandWithRetry, lowercaseKeys, parseJsonObjectOutput, proxyCleanup } from './helpers.js'

type HttpBinResponse = {
  headers: Record<string, string>
  json?: Record<string, unknown>
}

type Http2Output = {
  alpnProtocol: string
  status: number
  body: string
}

/**
 * Node helper that performs an HTTP/2 request, optionally tunneling through
 * the sandbox-injected HTTPS proxy via CONNECT + TLS ALPN negotiation.
 *
 * Usage: node /tmp/proxy-test-h2.js <method> <url> [headersJson] [body]
 * Stdout: single JSON object {alpnProtocol, status, body}
 */
const http2HelperScript = `
const http2 = require("http2");
const tls = require("tls");
const net = require("net");

const method = process.argv[2] || "GET";
const targetUrl = process.argv[3] || "https://example.com/headers";
const extraHeaders = process.argv[4] ? JSON.parse(process.argv[4]) : {};
const bodyData = process.argv[5] || null;
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy ||
                 process.env.HTTP_PROXY || process.env.http_proxy;
const target = new URL(targetUrl);

function fireH2(tlsSocket) {
  const negotiated = tlsSocket.alpnProtocol || "";
  if (negotiated !== "h2") {
    process.stdout.write(JSON.stringify({ alpnProtocol: negotiated || "(none)", status: 0, body: "" }));
    try { tlsSocket.destroy(); } catch (_) {}
    process.exit(0);
  }
  const client = http2.connect("https://" + target.hostname, {
    createConnection: () => tlsSocket,
  });
  client.on("error", (e) => { process.stderr.write("H2 ERR: " + e.message + "\\n"); process.exit(1); });

  const reqHeaders = {
    ":method": method,
    ":path": target.pathname + target.search,
    ":scheme": "https",
    ":authority": target.hostname,
  };
  for (const k of Object.keys(extraHeaders)) reqHeaders[k.toLowerCase()] = extraHeaders[k];
  if (bodyData) {
    reqHeaders["content-type"] = "application/json";
    reqHeaders["content-length"] = Buffer.byteLength(bodyData);
  }

  const req = client.request(reqHeaders);
  let status = 0;
  req.on("response", (h) => { status = parseInt(h[":status"]); });
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    process.stdout.write(JSON.stringify({ alpnProtocol: negotiated, status, body }));
    try { client.close(); } catch (_) {}
    process.exit(0);
  });
  req.on("error", (e) => { process.stderr.write("H2 REQ ERR: " + e.message + "\\n"); process.exit(1); });

  if (bodyData) req.write(bodyData);
  req.end();
}

function viaProxy() {
  const p = new URL(proxyUrl);
  const port = parseInt(p.port) || (p.protocol === "https:" ? 443 : 3128);
  const auth = (p.username || p.password)
    ? "Proxy-Authorization: Basic " +
      Buffer.from(decodeURIComponent(p.username||"") + ":" + decodeURIComponent(p.password||"")).toString("base64") + "\\r\\n"
    : "";
  const connectMsg = "CONNECT " + target.hostname + ":443 HTTP/1.1\\r\\n" +
    "Host: " + target.hostname + ":443\\r\\n" + auth + "\\r\\n";

  function onProxySocket(proxySock) {
    let buf = "";
    proxySock.on("data", function h(chunk) {
      buf += chunk.toString();
      if (buf.indexOf("\\r\\n\\r\\n") < 0) return;
      proxySock.removeListener("data", h);
      const code = parseInt(buf.split(" ")[1]);
      if (code !== 200) {
        process.stderr.write("CONNECT " + code + "\\n");
        process.exit(1);
      }
      const tlsSocket = tls.connect({
        socket: proxySock,
        servername: target.hostname,
        ALPNProtocols: ["h2", "http/1.1"],
      }, () => fireH2(tlsSocket));
      tlsSocket.on("error", (e) => { process.stderr.write("INNER TLS: " + e.message + "\\n"); process.exit(1); });
    });
    proxySock.write(connectMsg);
  }

  const timeout = setTimeout(() => { process.stderr.write("PROXY TIMEOUT\\n"); process.exit(1); }, 20000);
  if (p.protocol === "https:") {
    const s = tls.connect({ host: p.hostname, port }, () => { clearTimeout(timeout); onProxySocket(s); });
    s.on("error", (e) => { clearTimeout(timeout); process.stderr.write("PROXY TLS: " + e.message + "\\n"); process.exit(1); });
  } else {
    const s = net.connect({ host: p.hostname, port }, () => { clearTimeout(timeout); onProxySocket(s); });
    s.on("error", (e) => { clearTimeout(timeout); process.stderr.write("PROXY TCP: " + e.message + "\\n"); process.exit(1); });
  }
}

if (!proxyUrl) {
  const tlsSocket = tls.connect({
    host: target.hostname,
    port: 443,
    servername: target.hostname,
    ALPNProtocols: ["h2", "http/1.1"],
  }, () => fireH2(tlsSocket));
  tlsSocket.on("error", (e) => { process.stderr.write("DIRECT TLS: " + e.message + "\\n"); process.exit(1); });
} else {
  viaProxy();
}
`.trim()

describe('proxy end-to-end functionality over HTTP/2', () => {
  const createdSandboxes: string[] = []
  afterAll(proxyCleanup(createdSandboxes))

  let sandbox: Awaited<ReturnType<typeof SandboxInstance.create>>
  // Controlled httpbin-compatible upstream reached via a preview URL.
  let headersUrl: string
  let postUrl: string

  beforeAll(async () => {
    const echo = await createEchoServerSandbox(createdSandboxes)
    headersUrl = `${echo.url}/headers`
    postUrl = `${echo.url}/post`

    sandbox = await createReadyProxySandbox(
      async () => {
        const name = uniqueName("proxy-h2")
        const sandbox = await SandboxInstance.create({
          name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
          network: {
            proxy: {
              routing: [{
                destinations: [echo.host],
                headers: { "X-Proxy-Test": "header-injected", "X-Api-Key": "{{SECRET:test-api-key}}" },
                body: { "injected_field": "body-injected", "secret_body": "{{SECRET:test-api-key}}" },
                secrets: { "test-api-key": "resolved-secret-42" },
              }],
            },
          },
        })
        return { name, sandbox }
      },
      createdSandboxes,
      `node /tmp/proxy-test.js GET ${headersUrl}`,
      (result) => {
        if (result.exitCode !== 0) return false
        const headers = lowercaseKeys(parseJsonObjectOutput<HttpBinResponse>(result.logs).headers)
        return headers["x-proxy-test"] === "header-injected" && headers["x-api-key"] === "resolved-secret-42"
      },
    )
    await sandbox.fs.write("/tmp/proxy-test-h2.js", http2HelperScript)
  }, 180_000)

  it('negotiates h2 ALPN and routes HTTP/2 GET through the proxy with header injection', async () => {
    const result = await execProxyCommandWithRetry(sandbox, `node /tmp/proxy-test-h2.js GET ${headersUrl}`)
    expect(result.exitCode, result.logs).toBe(0)
    const out = parseJsonObjectOutput<Http2Output>(result.logs)
    expect(out.alpnProtocol, `expected ALPN h2, got "${out.alpnProtocol}"`).toBe("h2")
    expect(out.status).toBe(200)
    const httpbin = JSON.parse(out.body) as HttpBinResponse
    const headers = lowercaseKeys(httpbin.headers)
    expect(headers["x-proxy-test"]).toBe("header-injected")
    expect(headers["x-api-key"]).toBe("resolved-secret-42")
  }, 60_000)

  it('routes HTTP/2 POST through the proxy with body injection', async () => {
    const result = await execProxyCommandWithRetry(sandbox, `node /tmp/proxy-test-h2.js POST ${postUrl} '{}' '{"user_data":"from-h2"}'`)
    expect(result.exitCode, result.logs).toBe(0)
    const out = parseJsonObjectOutput<Http2Output>(result.logs)
    expect(out.alpnProtocol).toBe("h2")
    expect(out.status).toBe(200)
    const httpbin = JSON.parse(out.body) as HttpBinResponse
    expect(httpbin.json?.user_data).toBe("from-h2")
    expect(httpbin.json?.injected_field).toBe("body-injected")
    expect(httpbin.json?.secret_body).toBe("resolved-secret-42")
    const headers = lowercaseKeys(httpbin.headers)
    expect(headers["x-proxy-test"]).toBe("header-injected")
    expect(headers["x-api-key"]).toBe("resolved-secret-42")
  }, 60_000)

  it('preserves user-sent headers over HTTP/2 through the proxy', async () => {
    const result = await execProxyCommandWithRetry(sandbox, `node /tmp/proxy-test-h2.js GET ${headersUrl} '{"X-User-Custom":"from-h2-client"}'`)
    expect(result.exitCode, result.logs).toBe(0)
    const out = parseJsonObjectOutput<Http2Output>(result.logs)
    expect(out.alpnProtocol).toBe("h2")
    const httpbin = JSON.parse(out.body) as HttpBinResponse
    const headers = lowercaseKeys(httpbin.headers)
    expect(headers["x-user-custom"]).toBe("from-h2-client")
    expect(headers["x-proxy-test"]).toBe("header-injected")
  }, 60_000)
})
