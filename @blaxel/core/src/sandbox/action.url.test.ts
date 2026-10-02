import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../common/env.js", () => ({ env: process.env }));
import type { Sandbox } from "../client/types.gen.js";
import { SandboxAction } from "./action.js";
import { SandboxFileSystem } from "./filesystem/filesystem.js";
import { SandboxProcess } from "./process/process.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});

describe("sandbox url", () => {
  it.each(["https://sbx.example.com", "https://sbx.example.com/", "https://sbx.example.com//"])("joins paths onto %s", url => {
    const action = new SandboxAction({ metadata: { name: "s", url }, spec: {} });
    expect(action.url).toBe("https://sbx.example.com");
    expect(action.fallbackUrl).toBeNull();
  });

  it.each(["", "/"])("sends requests without a double slash (base suffix %j)", async suffix => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ message: "ok", path: "/tmp/a.bin", name: "p", pid: "1", status: "completed" }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing port");
    const sandbox = { metadata: { name: "local" }, spec: {}, forceUrl: `http://127.0.0.1:${address.port}${suffix}`, headers: {} } as Sandbox;
    const process = new SandboxProcess(sandbox);
    await process.get("p");
    await new SandboxFileSystem(sandbox, process).writeBinary("tmp/a.bin", new Uint8Array([1]));
    expect(paths).toEqual(["/process/p", "/filesystem/tmp/a.bin"]);
  });
});
