import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxProcess } from "../../@blaxel/core/src/sandbox/process/process.js";

type Seen = { method: string; url: string; contentType: string | undefined; body: string };

// stdin bodies must reach the wire verbatim: the generated client JSON-encodes
// by default, which would turn a JSON-RPC line into a quoted string.
describe("SandboxProcess stdin", () => {
  let server: Server;
  let baseUrl: string;
  const seen: Seen[] = [];

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, contentType: req.headers["content-type"], body });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ message: "ok" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    baseUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const proc = () => new SandboxProcess({ metadata: { name: "unit" }, forceUrl: baseUrl, headers: {} } as never);

  it("writes the body verbatim as octet-stream", async () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":"ping"}\n';
    await proc().writeStdin("mcp", line);
    const last = seen.at(-1)!;
    expect(last.method).toBe("POST");
    expect(last.url).toBe("/process/mcp/stdin");
    expect(last.contentType).toBe("application/octet-stream");
    expect(last.body).toBe(line);
  });

  it("closes stdin with a DELETE", async () => {
    await proc().closeStdin("mcp");
    const last = seen.at(-1)!;
    expect(last.method).toBe("DELETE");
    expect(last.url).toBe("/process/mcp/stdin");
  });
});
