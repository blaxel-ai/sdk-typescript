import { describe, expect, it, vi } from "vitest";
import { SandboxInstance } from "@blaxel/core";
import { createServer } from "node:http";

function createReadBinaryHarness(data: unknown, response?: Response) {
  const client = {
    get: vi.fn((options: unknown) => Promise.resolve({
      response: response ?? new Response("ok", { status: 200 }),
      data,
      error: undefined,
      options,
    })),
  };
  const filesystem = new SandboxInstance({
    metadata: { name: "binary-download-test" },
    spec: {},
    forceUrl: "http://127.0.0.1",
    headers: {},
  }).fs;
  Object.defineProperty(filesystem, "client", {
    get: () => client,
  });
  Object.defineProperty(filesystem, "url", {
    get: () => "https://sandbox.example",
  });
  return { filesystem, client };
}

async function blobText(blob: Blob): Promise<string> {
  return new TextDecoder().decode(await blob.arrayBuffer());
}

describe("SandboxFileSystem.readBinary", () => {
  it("requests blob parsing for headerless binary downloads", async () => {
    const { filesystem, client } = createReadBinaryHarness(
      new Blob([new Uint8Array([1, 2, 3])]),
    );

    const blob = await filesystem.readBinary("/tmp/file.bin");

    expect(blob).toBeInstanceOf(Blob);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(client.get).toHaveBeenCalledWith(
      expect.objectContaining({
        parseAs: "blob",
        headers: { Accept: "application/octet-stream" },
      }),
    );
  });

  it("normalizes a ReadableStream result into a Blob", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed"));
        controller.close();
      },
    });
    const { filesystem } = createReadBinaryHarness(stream);

    const blob = await filesystem.readBinary("/tmp/file.bin");

    expect(blob).toBeInstanceOf(Blob);
    await expect(blobText(blob)).resolves.toBe("streamed");
  });

  it("falls back to the response body when data is not binary-like", async () => {
    const response = new Response("body-bytes", { status: 200 });
    // A missing parsed value is rejected before normalization. Use a present,
    // non-binary value to exercise the response-body fallback itself.
    const { filesystem } = createReadBinaryHarness({}, response);

    const blob = await filesystem.readBinary("/tmp/file.bin");

    expect(blob).toBeInstanceOf(Blob);
    await expect(blobText(blob)).resolves.toBe("body-bytes");
  });

  it("rejects a missing parsed value before binary normalization", async () => {
    const { filesystem } = createReadBinaryHarness(undefined, new Response("body-bytes"));
    await expect(filesystem.readBinary("/tmp/file.bin")).rejects.toMatchObject({ status: 200 });
  });

  it("normalizes string and ArrayBuffer data into Blob values", async () => {
    const stringHarness = createReadBinaryHarness("text-data").filesystem;
    const bufferHarness = createReadBinaryHarness(
      new TextEncoder().encode("buffer-data").buffer,
    ).filesystem;

    await expect(blobText(await stringHarness.readBinary("/tmp/a"))).resolves.toBe(
      "text-data",
    );
    await expect(blobText(await bufferHarness.readBinary("/tmp/b"))).resolves.toBe(
      "buffer-data",
    );
  });
});

// These controls exercise parsing through the generated client and public SDK.
describe("SandboxFileSystem.readBinary HTTP responses", () => {
  it.each([
    { name: "headerless binary", status: 200, bytes: [0, 128, 255], headers: {} },
    { name: "empty file", status: 200, bytes: [], headers: { "Content-Length": "0" } },
    { name: "missing file", status: 404, bytes: [], headers: {} },
  ])("handles a $name response", async ({ status, bytes, headers }) => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url} ${request.headers.accept}`);
      response.writeHead(status, headers);
      response.end(Buffer.from(bytes));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP address");
      const sandbox = new SandboxInstance({
        metadata: { name: "binary-http-test" },
        spec: {},
        forceUrl: `http://127.0.0.1:${address.port}`,
        headers: {},
      });
      if (status === 200) {
        const blob = await sandbox.fs.readBinary("/tmp/file.bin");
        expect(blob).toBeInstanceOf(Blob);
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(bytes));
      } else {
        await expect(sandbox.fs.readBinary("/tmp/file.bin")).rejects.toMatchObject({ status });
      }
      expect(requests).toEqual(["GET /filesystem/%2Ftmp%2Ffile.bin application/octet-stream"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  });
});
