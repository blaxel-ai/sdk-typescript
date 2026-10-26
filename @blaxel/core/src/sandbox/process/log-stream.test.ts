import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../common/env.js", () => ({ env: process.env }));
import { SandboxProcess } from "./process.js";
import { createLogStreamParser } from "./log-stream.js";
import type { Sandbox } from "../../client/types.gen.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});
async function localServer(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server port");
  return new SandboxProcess({ metadata: { name: "local" }, spec: {}, forceUrl: `http://127.0.0.1:${address.port}`, headers: {} } as Sandbox);
}
const record = (type: string, data?: string, encoding?: string) => JSON.stringify({ type, data, encoding }) + "\n";

describe("structured process log streaming", () => {
  it("keeps interleaved source identity and exact bytes across fragmented HTTP records", async () => {
    const stdout: string[] = [], stderr: string[] = [], log: string[] = [];
    const outBytes: number[] = [], errBytes: number[] = [];
    const process = await localServer((request, response) => {
      expect(request.headers.accept).toBe("application/x-ndjson");
      response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      const body = record("stdout", "OUT") + record("stderr", "ERR\n") + record("stdout", "TAIL\n\nthree\r\n ");
      for (const byte of Buffer.from(body)) response.write(Buffer.from([byte]));
      response.end();
    });
    await process.streamLogs("p", {
      onStdout: value => stdout.push(value), onStderr: value => stderr.push(value), onLog: value => log.push(value),
      onStdoutChunk: value => outBytes.push(...value), onStderrChunk: value => errBytes.push(...value),
    }).wait();
    expect(stdout).toEqual(["OUTTAIL", "", "three", " "]);
    expect(stderr).toEqual(["ERR"]);
    expect(log).toEqual(["ERR", "OUTTAIL", "", "three", " "]);
    expect(Buffer.from(outBytes).toString()).toBe("OUTTAIL\n\nthree\r\n ");
    expect(Buffer.from(errBytes).toString()).toBe("ERR\n");
  });

  it("decodes split UTF-8 independently per source while preserving binary chunks", () => {
    const stdout: string[] = [], stderr: string[] = [], chunks: number[] = [];
    const parser = createLogStreamParser({ onStdout: x => stdout.push(x), onStderr: x => stderr.push(x), onStdoutChunk: x => chunks.push(...x) }, "ndjson");
    parser.push(new TextEncoder().encode(record("stdout", "4g==", "base64")));
    parser.push(new TextEncoder().encode(record("stderr", "é\n")));
    parser.push(new TextEncoder().encode(record("stdout", "gqz/Cg==", "base64")));
    parser.finish();
    expect(stdout).toEqual(["€�"]);
    expect(stderr).toEqual(["é"]);
    expect(chunks).toEqual([0xe2, 0x82, 0xac, 0xff, 10]);
  });

  it("does not accumulate decoded lines for raw-only consumers", () => {
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    try {
      let count = 0;
      const parser = createLogStreamParser({ onStdoutChunk: bytes => { count += bytes.length; } }, "ndjson");
      const encoded = record("stdout", "x".repeat(65536));
      for (let i = 0; i < 64; i++) parser.push(new TextEncoder().encode(encoded));
      parser.finish();
      expect(count).toBe(4 * 1024 * 1024);
      expect(new Set(decode.mock.contexts).size).toBe(1);
    } finally {
      decode.mockRestore();
    }
  });

  it("preserves a leading BOM and handles CRLF split across records", () => {
    const stdout: string[] = [];
    const parser = createLogStreamParser({ onStdout: x => stdout.push(x) }, "ndjson");
    parser.push(new TextEncoder().encode(record("stdout", "\uFEFFfirst\r")));
    parser.push(new TextEncoder().encode(record("stdout", "\n\nlast")));
    parser.finish();
    expect(stdout).toEqual(["\uFEFFfirst", "", "last"]);
  });

  it("flushes unfinished lines on restart and never emits control data as output", () => {
    const stdout: string[] = [], chunks: number[] = [];
    const parser = createLogStreamParser({ onStdout: x => stdout.push(x), onStdoutChunk: x => chunks.push(...x) }, "ndjson");
    parser.push(new TextEncoder().encode(record("stdout", "before")));
    parser.push(new TextEncoder().encode(record("keepalive")));
    parser.push(new TextEncoder().encode(record("restart", "restarting")));
    parser.push(new TextEncoder().encode(record("stdout", "after\n")));
    parser.finish();
    expect(stdout).toEqual(["before", "after"]);
    expect(Buffer.from(chunks).toString()).toBe("beforeafter\n");
  });

  it.each([
    [record("truncated", "retention gap"), "truncated"],
    [record("error", "read failed"), "read failed"],
    ["{bad-json}\n", "JSON"],
    [record("stdout", "!", "base64"), "base64"],
    [record("stdout", "x", "hex"), "encoding"],
    [record("unknown"), "Invalid process log record"],
  ])("rejects invalid or incomplete streams: %s", async (body, message) => {
    let disconnected!: () => void;
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    const process = await localServer((_request, response) => {
      response.setHeader("Content-Type", "application/x-ndjson");
      response.on("close", disconnected);
      response.write(body);
    });
    const onError = vi.fn();
    await expect(process.streamLogs("p", { onError }).wait()).rejects.toThrow(message);
    expect(onError).toHaveBeenCalledTimes(1);
    await closed;
  });

  it("supports a final NDJSON record without a newline", async () => {
    const stdout: string[] = [];
    const process = await localServer((_request, response) => {
      response.setHeader("Content-Type", "application/x-ndjson");
      response.end(record("stdout", "tail").trimEnd());
    });
    await process.streamLogs("p", { onStdout: x => stdout.push(x) }).wait();
    expect(stdout).toEqual(["tail"]);
  });

  it("retains legacy text line callbacks but refuses raw callbacks", async () => {
    const process = await localServer((_request, response) => {
      response.setHeader("Content-Type", "text/plain");
      response.end("stdout:one\r\n[keepalive]\nstderr:two\ntail");
    });
    const onLog = vi.fn();
    await process.streamLogs("p", { onLog }).wait();
    expect(onLog.mock.calls).toEqual([["one"], ["two"], ["tail"]]);
    await expect(process.streamLogs("p", { onStdoutChunk: vi.fn() }).wait()).rejects.toThrow("application/x-ndjson");
  });

  it("retries unsupported structured history as text only for line consumers", async () => {
    const accepts: (string | undefined)[] = [];
    const process = await localServer((request, response) => {
      accepts.push(request.headers.accept);
      if (request.headers.accept === "application/x-ndjson") {
        response.writeHead(409, { "Content-Type": "application/json" });
        response.end('{"error":"structured history unavailable"}');
      } else {
        response.setHeader("Content-Type", "text/plain");
        response.end("stdout:legacy\n");
      }
    });
    const onStdout = vi.fn();
    await process.streamLogs("p", { onStdout }).wait();
    expect(accepts).toEqual(["application/x-ndjson", "text/plain"]);
    expect(onStdout).toHaveBeenCalledWith("legacy");
    await expect(process.streamLogs("p", { onStdoutChunk: vi.fn() }).wait()).rejects.toThrow("409");
    expect(accepts).toHaveLength(3);
  });

  it("closes during an incomplete record without parsing or double-flushing it", async () => {
    const handle = { close: () => {} };
    const stdout: string[] = [];
    const onChunk = vi.fn(() => { setTimeout(() => handle.close(), 0); });
    const process = await localServer((_request, response) => {
      response.setHeader("Content-Type", "application/x-ndjson");
      response.write(record("stdout", "tail") + '{"type":"stdout","data":"unfinished');
    });
    const stream = process.streamLogs("p", { onStdout: x => stdout.push(x), onStdoutChunk: onChunk });
    handle.close = stream.close;
    await expect(stream.wait()).resolves.toBeUndefined();
    expect(stdout).toEqual(["tail"]);
    expect(onChunk).toHaveBeenCalledTimes(1);
  });

  it("propagates callback exceptions even when the callback closes the stream", async () => {
    const handle = { close: () => {} };
    const process = await localServer((_request, response) => {
      response.setHeader("Content-Type", "application/x-ndjson");
      response.write(record("stdout", "hello\n"));
    });
    const onError = vi.fn();
    const stream = process.streamLogs("p", { onError, onStdout: () => { handle.close(); throw new Error("callback failed"); } });
    handle.close = stream.close;
    await expect(stream.wait()).rejects.toThrow("callback failed");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("flushes a partial legacy line on explicit close", async () => {
    let attached!: () => void;
    const ready = new Promise<void>(resolve => { attached = resolve; });
    const process = await localServer((_request, response) => {
      response.setHeader("Content-Type", "text/plain");
      response.write("stdout:tail");
      setTimeout(attached, 20);
    });
    const stdout: string[] = [];
    const stream = process.streamLogs("p", { onStdout: x => stdout.push(x) });
    await ready;
    stream.close();
    await stream.wait();
    expect(stdout).toEqual(["tail"]);
  });
});
