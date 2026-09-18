import { SandboxInstance } from "@blaxel/core";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

async function withProcess(check: (process: SandboxInstance["process"], bodies: string[]) => Promise<void>) {
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      bodies.push(body);
      const result = { pid: "example", status: "completed", exitCode: 0, stdout: "out", stderr: "err" };
      if (request.headers.accept === "text/event-stream") {
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        response.end([
          JSON.stringify({ type: "stdout", data: "out" }),
          JSON.stringify({ type: "stderr", data: "err" }),
          JSON.stringify({ type: "result", data: JSON.stringify(result) }),
        ].join("\n") + "\n");
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(result));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    const sandbox = new SandboxInstance({ metadata: { name: "options-regression" }, spec: {}, forceUrl: `http://127.0.0.1:${address.port}`, headers: {} });
    await check(sandbox.process, bodies);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe("SandboxProcess.exec input ownership", () => {
  it("preserves every callback and streams when an options object is reused", async () => {
    await withProcess(async (process, bodies) => {
      const logs: string[] = [];
      const stdout: string[] = [];
      const stderr: string[] = [];
      const request = {
        command: "echo example",
        waitForCompletion: true,
        onLog: (value: string) => { logs.push(value); },
        onStdout: (value: string) => { stdout.push(value); },
        onStderr: (value: string) => { stderr.push(value); },
      };
      const original = { ...request };
      await process.exec(request);
      await process.exec(request);
      expect(stdout).toEqual(["out", "out"]);
      expect(stderr).toEqual(["err", "err"]);
      expect(logs).toEqual(["out", "err", "out", "err"]);
      expect(request).toEqual(original);
      expect(bodies).toEqual([JSON.stringify({ command: request.command, waitForCompletion: true }), JSON.stringify({ command: request.command, waitForCompletion: true })]);
    });
  });

  it.each(["onLog", "onStdout", "onStderr"])("accepts frozen options with %s", async callbackName => {
    await withProcess(async (process, bodies) => {
      const output: string[] = [];
      const request = Object.freeze({ command: "echo example", waitForCompletion: true, [callbackName]: (value: string) => { output.push(value); } });
      await expect(process.exec(request)).resolves.toMatchObject({ status: "completed" });
      expect(output).toEqual(callbackName === "onLog" ? ["out", "err"] : [callbackName === "onStdout" ? "out" : "err"]);
      expect(bodies).toEqual([JSON.stringify({ command: request.command, waitForCompletion: true })]);
    });
  });

  it.each([true, false])("preserves plain options with waitForCompletion=%s", async waitForCompletion => {
    await withProcess(async (process, bodies) => {
      const request = Object.freeze({ command: "echo example", waitForCompletion });
      await expect(process.exec(request)).resolves.toMatchObject({ status: "completed" });
      expect(bodies).toEqual([JSON.stringify(request)]);
    });
  });
});
