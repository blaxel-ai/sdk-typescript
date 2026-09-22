import { createServer, type Server, type RequestListener } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../common/env.js", () => ({ env: process.env }));
import { SandboxProcess } from "./process.js";
import { ProcessExecutionError } from "./state.js";
import type { Sandbox } from "../../client/types.gen.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function localServer(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing port");
  return new SandboxProcess({ metadata: { name: "local" }, spec: {}, forceUrl: `http://127.0.0.1:${address.port}`, headers: {} } as Sandbox);
}
describe("process HTTP contract", () => {
  it("preserves generated identity after a lost POST response and never retries POST", async () => {
    let starts = 0; let name = "";
    const process = await localServer((request, response) => {
      void (async () => {
      if (request.method === "POST") {
        starts++; const chunks: Buffer[] = []; for await (const chunk of request) { if (Buffer.isBuffer(chunk)) chunks.push(chunk); }
        name = (JSON.parse(Buffer.concat(chunks).toString()) as { name: string }).name; response.destroy(); return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ name, status: "completed", exitCode: 0, stdout: "done" }));
      })().catch((error: Error) => response.destroy(error));
    });
    const input = { command: "echo done" };
    let error: unknown; try { await process.exec(input); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ProcessExecutionError);
    expect(error).toMatchObject({ identifier: name }); expect(name).toMatch(/^process-/);
    expect(input).toEqual({ command: "echo done" });
    expect((await process.wait(name)).status).toBe("completed"); expect(starts).toBe(1);
  });
  it("rejects failed log streams while intentional close remains successful", async () => {
    let streaming = false;
    const process = await localServer((_request, response) => {
      if (!streaming) { response.writeHead(503); response.end("unavailable"); return; }
      response.writeHead(200, { "content-type": "text/plain" }); response.write("stdout:hello\n");
    });
    const onError = vi.fn(); await expect(process.streamLogs("p", { onError }).wait()).rejects.toThrow("unavailable");
    expect(onError).toHaveBeenCalledTimes(1);
    streaming = true; const stream = process.streamLogs("p"); stream.close(); await expect(stream.wait()).resolves.toBeUndefined();
  });
  it("retries real status HTTP errors within the wait deadline", async () => {
    let reads = 0;
    const process = await localServer((_request, response) => {
      reads++;
      response.setHeader("content-type", "application/json");
      if (reads === 1) { response.writeHead(503); response.end(JSON.stringify({ error: "unavailable" })); return; }
      response.end(JSON.stringify({ status: "completed", exitCode: 0 }));
    });
    expect((await process.wait("p", { maxWait: 2000 })).status).toBe("completed");
    expect(reads).toBe(2);
  });
  it("observes after a lost kill response, without sending kill twice", async () => {
    let kills = 0;
    const process = await localServer((request, response) => {
      if (request.method === "DELETE") { kills++; response.destroy(); return; }
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ status: "killed" }));
    });
    expect((await process.killAndWait("p", { maxWait: 2000 })).status).toBe("killed"); expect(kills).toBe(1);
  });
});
