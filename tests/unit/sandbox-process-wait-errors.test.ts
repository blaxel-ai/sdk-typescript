import { SandboxInstance } from "@blaxel/core";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

type Reply = { statusCode?: number; body: object };

async function withProcess(
  replies: Reply[],
  check: (process: SandboxInstance["process"], requests: string[]) => Promise<void>,
) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
    response.writeHead(reply.statusCode ?? 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    const sandbox = new SandboxInstance({
      metadata: { name: "wait-regression" },
      spec: {},
      forceUrl: `http://127.0.0.1:${address.port}`,
      headers: {},
    });
    await check(sandbox.process, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe("SandboxProcess.wait polling errors", () => {
  it.each([401, 404, 500])("rejects a subsequent HTTP %i instead of returning a running process", async statusCode => {
    await withProcess([
      { body: { pid: "example", status: "running" } },
      { statusCode, body: { error: "Status lookup failed" } },
    ], async (process, requests) => {
      await expect(process.wait("example", { interval: 1, maxWait: 1000 })).rejects.toMatchObject({ status: statusCode });
      expect(requests).toEqual(["GET /process/example", "GET /process/example"]);
    });
  });

  it("preserves failure of the initial lookup", async () => {
    await withProcess([{ statusCode: 500, body: { error: "Initial lookup failed" } }], async (process, requests) => {
      await expect(process.wait("example", { interval: 1 })).rejects.toMatchObject({ status: 500 });
      expect(requests).toHaveLength(1);
    });
  });

  it.each(["completed", "failed", "killed"])("returns an initially %s process without polling", async status => {
    const body = { pid: "example", status, exitCode: 0 };
    await withProcess([{ body }], async (process, requests) => {
      await expect(process.wait("example", { interval: 1000 })).resolves.toEqual(body);
      expect(requests).toHaveLength(1);
    });
  });

  it("returns the terminal result after a successful poll", async () => {
    const completed = { pid: "example", status: "completed", stdout: "done", exitCode: 0 };
    await withProcess([{ body: { pid: "example", status: "running" } }, { body: completed }], async (process, requests) => {
      await expect(process.wait("example", { interval: 1, maxWait: 1000 })).resolves.toEqual(completed);
      expect(requests).toHaveLength(2);
    });
  });

  it("still rejects when the process exceeds the wait budget", async () => {
    await withProcess([{ body: { pid: "example", status: "running" } }], async process => {
      await expect(process.wait("example", { interval: 5, maxWait: 1 })).rejects.toThrow("Process did not finish in time");
    });
  });
});
