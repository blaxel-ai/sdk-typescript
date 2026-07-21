import { SandboxInstance } from "@blaxel/core"
import { defaultImage, defaultLabels, defaultRegion, fetchWithRetry, uniqueName } from '../helpers.js'

/**
 * An httpbin-compatible echo server. It mirrors the subset of httpbin endpoints
 * the proxy tests rely on, so we never depend on the public httpbin.org (which
 * intermittently returns 503). It runs inside a sandbox and is exposed through a
 * public preview URL.
 *
 * Supported endpoints:
 *  - `/get`, `/post`, `/put`, `/delete`, `/headers`, `/anything` (and any other
 *    path): returns `{ headers, json, data, args, method, path, url }` where
 *    `json` is the parsed request body (httpbin-style).
 *  - `/redirect/N`: 302s N times, ending at `/get` (for `curl -L`).
 *  - `/bytes/N`: returns exactly N bytes of data (for download-size checks).
 */
export const echoServerScript = `
const http = require("http");
const crypto = require("crypto");
const port = parseInt(process.env.ECHO_PORT || "3000", 10);

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString();
    const host = req.headers.host || "localhost";
    const u = new URL(req.url, "http://" + host);
    const path = u.pathname;

    const redirectMatch = path.match(/^\\/redirect\\/(\\d+)$/);
    if (redirectMatch) {
      const n = parseInt(redirectMatch[1], 10);
      const location = n <= 1 ? "/get" : "/redirect/" + (n - 1);
      res.writeHead(302, { Location: location });
      res.end();
      return;
    }

    const bytesMatch = path.match(/^\\/bytes\\/(\\d+)$/);
    if (bytesMatch) {
      const n = parseInt(bytesMatch[1], 10);
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(crypto.randomBytes(n));
      return;
    }

    let json = null;
    if (raw) { try { json = JSON.parse(raw); } catch (e) { json = null; } }
    const args = {};
    for (const [k, v] of u.searchParams.entries()) args[k] = v;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      headers: req.headers,
      json,
      data: raw,
      args,
      method: req.method,
      path,
      url: "https://" + host + req.url,
    }));
  });
}).listen(port, () => { console.log("echo server listening on " + port); });
`.trim()

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

export function parseJsonObjectOutput<T extends object>(logs: string | undefined): T {
  return parseJsonOutput(logs) as T
}

export function lowercaseKeys(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v])
  )
}

type Sandbox = Awaited<ReturnType<typeof SandboxInstance.create>>
type ExecResult = Awaited<ReturnType<Sandbox["process"]["exec"]>>

export type EchoServer = {
  sandbox: Sandbox
  /** Hostname only (e.g. `prefix-workspace.preview.blaxel.dev`), for proxy `destinations`. */
  host: string
  /** Full base URL (e.g. `https://prefix-workspace.preview.blaxel.dev`). */
  url: string
}

/**
 * Creates a sandbox running {@link echoServerScript}, exposes it through a public
 * preview, and waits until the preview URL is reachable. Use the returned `host`
 * as a proxy `destinations` entry and target `${url}/headers` or `${url}/post`
 * from inside a proxied sandbox to get deterministic, httpbin-compatible
 * responses without relying on the public httpbin.org.
 */
export async function createEchoServerSandbox(
  createdSandboxes: string[],
  { port = 3000 }: { port?: number } = {},
): Promise<EchoServer> {
  const name = uniqueName("proxy-echo")
  const sandbox = await SandboxInstance.create({
    name, image: defaultImage, region: defaultRegion, labels: defaultLabels,
    ports: [{ target: port }],
  })
  createdSandboxes.push(name)

  await sandbox.fs.write("/tmp/echo-server.js", echoServerScript)
  await sandbox.process.exec({
    command: `ECHO_PORT=${port} node /tmp/echo-server.js`,
    waitForPorts: [port],
  })

  const preview = await sandbox.previews.create({
    metadata: { name: uniqueName("echo-preview") },
    spec: { port, public: true },
  })
  const url = preview.spec.url
  if (!url) throw new Error("Echo server preview did not return a URL")
  const host = new URL(url).hostname

  // Block until the preview is actually serving (infra propagation can lag).
  const ready = await fetchWithRetry(`${url}/headers`, undefined, { retries: 15, delayMs: 2000 })
  if (ready.status !== 200) {
    throw new Error(`Echo server preview not reachable: status=${ready.status} url=${url}`)
  }

  return { sandbox, host, url }
}

export async function execProxyCommandWithRetry(
  sandbox: Sandbox,
  command: string,
  { retries = 10, delayMs = 2000 }: { retries?: number; delayMs?: number } = {},
): Promise<ExecResult> {
  let result: ExecResult | undefined
  for (let i = 0; i <= retries; i++) {
    result = await sandbox.process.exec({ command, waitForCompletion: true })
    if (result.exitCode === 0) return result
    if (i < retries) await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  return result!
}

export async function createReadyProxySandbox(
  createSandbox: () => Promise<{ name: string; sandbox: Sandbox }>,
  createdSandboxes: string[],
  readyCommand: string,
  isReady: (result: ExecResult) => boolean = (result) => result.exitCode === 0,
  { attempts = 3, retries = 10, delayMs = 2000 }: { attempts?: number; retries?: number; delayMs?: number } = {},
): Promise<Sandbox> {
  let lastResult: ExecResult | undefined
  for (let i = 0; i < attempts; i++) {
    const { name, sandbox } = await createSandbox()
    createdSandboxes.push(name)
    await sandbox.fs.write("/tmp/proxy-test.js", proxyHelperScript)

    lastResult = await execProxyCommandWithRetry(sandbox, readyCommand, { retries, delayMs })
    if (isReady(lastResult)) return sandbox

    try { await SandboxInstance.delete(name) } catch {
      // Best-effort cleanup for a sandbox that never became proxy-ready.
    }
    if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, delayMs))
  }

  throw new Error(`Proxy sandbox did not become ready after ${attempts} attempts. Last exitCode=${lastResult?.exitCode}; logs=${lastResult?.logs ?? ""}`)
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
        try { await SandboxInstance.delete(name) } catch {
          // Best-effort cleanup: another test cleanup path may already have removed it.
        }
      })
    )
  }
}
