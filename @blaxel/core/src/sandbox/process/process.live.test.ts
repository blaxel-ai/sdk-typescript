import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../common/env.js", () => ({ env: process.env }));
import { SandboxProcess } from "./process.js";
import { ProcessExecutionError, ProcessObservationError } from "./state.js";
import type { Sandbox } from "../../client/types.gen.js";

// Opt-in disposable sandbox API. No credentials or .env files are loaded.
const url = process.env.LOCAL_PROCESS_API_URL;
const client = (forceUrl: string) => new SandboxProcess({ metadata: { name: "local-process-tests" }, spec: {}, forceUrl, headers: {} } as Sandbox);
describe.skipIf(!url)("real sandbox process API", () => {
  it("reconnects after wait timeout and recovers exit code and logs", async () => {
    const api = client(url!); const name = `ts-timeout-${randomUUID()}`;
    await api.exec({ name, command: "sleep 1; echo recovered; exit 7", waitForCompletion: false, keepAlive: false });
    await expect(api.wait(name, { maxWait: 20, interval: 5 })).rejects.toBeInstanceOf(ProcessObservationError);
    const result = await api.wait(name, { maxWait: 5000, interval: 20 });
    expect(result.status).toBe("failed"); expect(result.exitCode).toBe(7);
    expect(await api.logs(name)).toContain("recovered");
  });
  it("cancels only observation, then explicitly kills and confirms the original command", async () => {
    const api = client(url!); const name = `ts-cancel-${randomUUID()}`;
    await api.exec({ name, command: "sleep 30", waitForCompletion: false, keepAlive: false });
    try {
      const controller = new AbortController(); controller.abort("done waiting");
      await expect(api.wait(name, { signal: controller.signal })).rejects.toMatchObject({ reason: "cancelled" });
      expect((await api.get(name)).status).toBe("running");
      const result = await api.killAndWait(name, { maxWait: 5000, interval: 20 });
      expect(["killed", "failed", "completed"]).toContain(result.status);
    } finally { await api.kill(name).catch(() => {}); }
  });
  it("gracefully stops and confirms an API terminal state", async () => {
    const api = client(url!); const name = `ts-stop-${randomUUID()}`;
    await api.exec({ name, command: "sleep 30", waitForCompletion: false, keepAlive: false });
    try {
      const result = await api.stopAndWait(name, { maxWait: 5000, interval: 20 });
      expect(["stopped", "failed", "completed"]).toContain(result.status);
    } finally { await api.kill(name).catch(() => {}); }
  });
  it("streams logs and the final result through the generated client", async () => {
    const api = client(url!); const output: string[] = [];
    const result = await api.exec({ name: `ts-stream-${randomUUID()}`, command: "echo streamed-live", waitForCompletion: true, keepAlive: false, onLog: line => output.push(line) });
    expect(result.status).toBe("completed"); expect(result.exitCode).toBe(0);
    expect(output.join("\n")).toContain("streamed-live");
  });
  it("recovers the original command after its execution response is lost", async () => {
    let posts = 0;
    const server = createServer((request, response) => {
      void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) { if (Buffer.isBuffer(chunk)) chunks.push(chunk); }
      const body = Buffer.concat(chunks);
      const upstream = await fetch(`${url}${request.url}`, { method: request.method, headers: { "content-type": "application/json" }, body: body.length ? body : undefined });
      await upstream.arrayBuffer(); posts++; response.destroy();
      })().catch((error: Error) => response.destroy(error));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing port");
    const proxy = client(`http://127.0.0.1:${address.port}`);
    try {
      let failure: unknown;
      try { await proxy.exec({ command: "echo exactly-once", waitForCompletion: true, keepAlive: false }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(ProcessExecutionError);
      const identifier = (failure as ProcessExecutionError).identifier;
      const api = client(url!); const result = await api.wait(identifier, { maxWait: 5000 });
      expect(result.status).toBe("completed"); expect(result.exitCode).toBe(0);
      expect((await api.logs(identifier)).match(/exactly-once/g)).toHaveLength(1); expect(posts).toBe(1);
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
