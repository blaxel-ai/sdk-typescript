import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../common/env.js", () => ({ env: process.env }));
process.env.BL_API_KEY = "test-key";
process.env.BL_WORKSPACE = "test-workspace";
import "../common/autoload.js";
import type { Sandbox } from "../client/types.gen.js";
import { SandboxProcess } from "./process/process.js";
import { SandboxNetwork } from "./network/network.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return `http://127.0.0.1:${address.port}`;
}

async function redirectingSandbox(): Promise<{ origin: string; targetHits: () => number }> {
  let hits = 0;
  const target = await listen((_request, response) => {
    hits++;
    response.end("{}");
  });
  const origin = await listen((_request, response) => {
    response.writeHead(302, { location: `${target.replace("127.0.0.1", "localhost")}/elsewhere` });
    response.end();
  });
  return { origin, targetHits: () => hits };
}

describe("sandbox requests do not follow redirects", () => {
  it("generated client", async () => {
    const { origin, targetHits } = await redirectingSandbox();
    const process = new SandboxProcess({ metadata: { name: "local", url: origin }, spec: {} });
    await expect(process.get("p")).rejects.toThrow();
    expect(targetHits()).toBe(0);
  });

  it("generated client with forceUrl", async () => {
    const { origin, targetHits } = await redirectingSandbox();
    const process = new SandboxProcess({ metadata: { name: "local" }, spec: {}, forceUrl: origin, headers: {} } as Sandbox);
    await expect(process.get("p")).rejects.toThrow();
    expect(targetHits()).toBe(0);
  });

  it("raw fetch", async () => {
    const { origin, targetHits } = await redirectingSandbox();
    const network = new SandboxNetwork({ metadata: { name: "local", url: origin }, spec: {} });
    const response = await network.fetch(3000, "/");
    expect(response.status).toBe(302);
    expect(targetHits()).toBe(0);
  });
});
