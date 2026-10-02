import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../common/env.js", () => ({ env: process.env }));
import type { Sandbox } from "../../client/types.gen.js";
import { SandboxProcess } from "../process/index.js";
import { SandboxFileSystem } from "./filesystem.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});

async function localFilesystem(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing port");
  const sandbox = { metadata: { name: "local" }, spec: {}, forceUrl: `http://127.0.0.1:${address.port}`, headers: {} } as Sandbox;
  return new SandboxFileSystem(sandbox, new SandboxProcess(sandbox));
}

// Fails the first PUT with an edge gateway status, then answers like the sandbox.
function flakyPutServer(puts: string[], status = 503): RequestListener {
  return (request, response) => {
    puts.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (puts.length === 1) { response.writeHead(status); response.end(JSON.stringify({ error: "unavailable" })); return; }
    response.end(JSON.stringify({ message: "ok", path: "/tmp/x" }));
  };
}

describe("filesystem PUT retries", () => {
  it.each([
    ["write", (fs: SandboxFileSystem) => fs.write("/tmp/a.txt", "hello")],
    ["mkdir", (fs: SandboxFileSystem) => fs.mkdir("/tmp/dir")],
    ["writeTree", (fs: SandboxFileSystem) => fs.writeTree([{ path: "a.txt", content: "a" }], "/tmp")],
    ["writeBinary", (fs: SandboxFileSystem) => fs.writeBinary("/tmp/a.bin", new Uint8Array([1, 2, 3]))],
  ])("%s retries a transient gateway failure", async (_name, put) => {
    const puts: string[] = [];
    const fs = await localFilesystem(flakyPutServer(puts));
    await expect(put(fs)).resolves.toBeDefined();
    expect(puts).toHaveLength(2);
    expect(puts.every(request => request.startsWith("PUT "))).toBe(true);
  });

  it.each([
    ["write", (fs: SandboxFileSystem) => fs.write("/tmp/a.txt", "hello")],
    ["mkdir", (fs: SandboxFileSystem) => fs.mkdir("/tmp/dir")],
  ])("%s does not retry an application error", async (_name, put) => {
    const puts: string[] = [];
    const fs = await localFilesystem(flakyPutServer(puts, 400));
    await expect(put(fs)).rejects.toThrow("400");
    expect(puts).toHaveLength(1);
  });
});

function recordingServer(urls: URL[], body: unknown): RequestListener {
  return (request, response) => {
    urls.push(new URL(request.url ?? "/", "http://localhost"));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  };
}

describe("filesystem search", () => {
  it("sends the fuzzy search query as the query param", async () => {
    const urls: URL[] = [];
    const fs = await localFilesystem(recordingServer(urls, { matches: [], total: 0 }));
    await fs.search("main.go", "/app", { maxResults: 5 });
    expect(urls[0].searchParams.get("query")).toBe("main.go");
    expect(urls[0].searchParams.get("maxResults")).toBe("5");
  });

  it("omits an empty fuzzy search query", async () => {
    const urls: URL[] = [];
    const fs = await localFilesystem(recordingServer(urls, { matches: [], total: 0 }));
    await fs.search("", "/app");
    expect(urls[0].searchParams.has("query")).toBe(false);
  });
});
