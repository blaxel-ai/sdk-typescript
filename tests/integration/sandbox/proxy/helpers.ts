import { SandboxInstance } from "@blaxel/core"

export const proxyHelperScript = `
const https = require("https");
const tls = require("tls");
const method = process.argv[2] || "GET";
const targetUrl = process.argv[3] || "https://httpbin.org/headers";
const extraHeaders = process.argv[4] ? JSON.parse(process.argv[4]) : {};
const bodyData = process.argv[5] || null;
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy ||
                 process.env.HTTP_PROXY || process.env.http_proxy;

function fire(socket) {
  const t = new URL(targetUrl);
  const opts = {
    hostname: t.hostname, port: t.port || 443,
    path: t.pathname + t.search, method,
    headers: { ...extraHeaders }, servername: t.hostname,
  };
  if (socket) { opts.socket = socket; opts.agent = false; }
  if (bodyData) {
    opts.headers["Content-Type"] = "application/json";
    opts.headers["Content-Length"] = Buffer.byteLength(bodyData);
  }
  const req = https.request(opts, (r) => {
    let d = ""; r.on("data", c => d += c);
    r.on("end", () => { process.stdout.write(d); process.exit(0); });
  });
  req.on("error", (e) => { process.stderr.write("REQ ERR: " + e.message + "\\n"); process.exit(1); });
  if (bodyData) req.write(bodyData);
  req.end();
}

if (!proxyUrl) { fire(null); }
else {
  const p = new URL(proxyUrl);
  const t = new URL(targetUrl);
  const port = parseInt(p.port) || (p.protocol === "https:" ? 443 : 3128);
  const auth = (p.username || p.password)
    ? "Proxy-Authorization: Basic " +
      Buffer.from(decodeURIComponent(p.username||"") + ":" + decodeURIComponent(p.password||"")).toString("base64") + "\\r\\n"
    : "";
  const connectMsg = "CONNECT " + t.hostname + ":443 HTTP/1.1\\r\\n" +
    "Host: " + t.hostname + ":443\\r\\n" + auth + "\\r\\n";

  function onSocket(sock) {
    let buf = "";
    sock.on("data", function h(chunk) {
      buf += chunk.toString();
      if (buf.indexOf("\\r\\n\\r\\n") < 0) return;
      sock.removeListener("data", h);
      const code = parseInt(buf.split(" ")[1]);
      if (code !== 200) {
        process.stderr.write("CONNECT " + code + "\\n");
        process.exit(1);
      }
      fire(sock);
    });
    sock.write(connectMsg);
  }

  const timeout = setTimeout(() => { process.stderr.write("PROXY TIMEOUT\\n"); process.exit(1); }, 15000);
  if (p.protocol === "https:") {
    const s = tls.connect({ host: p.hostname, port }, () => { clearTimeout(timeout); onSocket(s); });
    s.on("error", (e) => { clearTimeout(timeout); process.stderr.write("PROXY TLS: " + e.message + "\\n"); process.exit(1); });
  } else {
    const s = require("net").connect({ host: p.hostname, port }, () => { clearTimeout(timeout); onSocket(s); });
    s.on("error", (e) => { clearTimeout(timeout); process.stderr.write("PROXY TCP: " + e.message + "\\n"); process.exit(1); });
  }
}
`.trim()

export function parseJsonOutput(logs: string | undefined): any {
  if (!logs) throw new Error("No output from command")
  const trimmed = logs.trim()
  const jsonStart = trimmed.indexOf('{')
  if (jsonStart === -1) throw new Error(`No JSON found in output: ${trimmed.slice(0, 200)}`)
  let depth = 0
  let jsonEnd = -1
  for (let i = jsonStart; i < trimmed.length; i++) {
    if (trimmed[i] === '{') depth++
    else if (trimmed[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break } }
  }
  if (jsonEnd === -1) throw new Error(`Unterminated JSON in output: ${trimmed.slice(0, 300)}`)
  return JSON.parse(trimmed.slice(jsonStart, jsonEnd))
}

export function lowercaseKeys(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v])
  )
}

export function proxyCleanup(createdSandboxes: string[]) {
  return async () => {
    if (process.env.SKIP_CLEANUP === '1') {
      console.log('SKIP_CLEANUP=1: skipping teardown. Resources to clean up manually:')
      console.log('  Sandboxes:', createdSandboxes)
      return
    }
    await Promise.all(
      createdSandboxes.map(async (name) => {
        try { await SandboxInstance.delete(name) } catch {}
      })
    )
  }
}
