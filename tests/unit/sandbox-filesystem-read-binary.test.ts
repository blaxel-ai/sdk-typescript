import { describe, expect, it, vi } from "vitest";
import { SandboxFileSystem } from "../../@blaxel/core/src/sandbox/filesystem/filesystem.js";

type ReadBinaryHarness = SandboxFileSystem & {
  readBinary(path: string): Promise<Blob>;
};

function createReadBinaryHarness(data: unknown, response?: Response) {
  const client = {
    get: vi.fn((options: unknown) => Promise.resolve({
      response: response ?? new Response("ok", { status: 200 }),
      data,
      error: undefined,
      options,
    })),
  };
  const filesystem = Object.create(SandboxFileSystem.prototype) as ReadBinaryHarness;
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
    const { filesystem } = createReadBinaryHarness(undefined, response);

    const blob = await filesystem.readBinary("/tmp/file.bin");

    expect(blob).toBeInstanceOf(Blob);
    await expect(blobText(blob)).resolves.toBe("body-bytes");
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
