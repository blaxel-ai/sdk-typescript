import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../common/env.js", () => ({ env: process.env }));
import { SandboxProcess } from "./process.js";
import type { Sandbox } from "../../client/types.gen.js";

let server: Server | undefined;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
});

describe("process log source regression", () => {
  it("delivers interleaved partial output to the correct source callbacks", async () => {
    server = createServer((request, response) => {
      // Match the API's text and NDJSON formats for the same writes. The process
      // writes OUT to stdout, ERR\n to stderr, then TAIL\n to stdout.
      if (request.headers.accept === "application/x-ndjson") {
        response.setHeader("Content-Type", "application/x-ndjson");
        response.end(
          JSON.stringify({ type: "stdout", data: "OUT" }) + "\n" +
          JSON.stringify({ type: "stderr", data: "ERR\n" }) + "\n" +
          JSON.stringify({ type: "stdout", data: "TAIL\n" }) + "\n"
        );
      } else {
        response.setHeader("Content-Type", "text/plain");
        response.end("stdout:OUTstderr:ERR\nTAIL\n");
      }
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server port");
    const process = new SandboxProcess({
      metadata: { name: "regression" }, spec: {},
      forceUrl: `http://127.0.0.1:${address.port}`, headers: {},
    } as Sandbox);
    const stdout: string[] = [];
    const stderr: string[] = [];
    await process.streamLogs("p", {
      onStdout: line => stdout.push(line),
      onStderr: line => stderr.push(line),
    }).wait();
    expect(stdout).toEqual(["OUTTAIL"]);
    expect(stderr).toEqual(["ERR"]);
  });
});
