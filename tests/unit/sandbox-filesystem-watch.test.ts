import { describe, expect, it, vi } from "vitest";
import { SandboxFileSystem } from "../../@blaxel/core/src/sandbox/filesystem/filesystem.js";

function createWatchHarness(body: ReadableStream<Uint8Array>) {
  const get = vi.fn().mockResolvedValue({ response: new Response(null, { status: 200 }), data: body });
  const filesystem = Object.create(SandboxFileSystem.prototype) as SandboxFileSystem;
  Object.defineProperties(filesystem, {
    client: { get: () => ({ get }) },
    url: { get: () => "https://sandbox.example" },
  });
  return filesystem;
}

function streamOf(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("SandboxFileSystem.watch", () => {
  it("reports keepalives, a trailing unterminated event, then the server close", async () => {
    const fs = createWatchHarness(
      streamOf('{"op":"CREATE","name":"a","path":"/x"}\n[keepalive]\n{"op":"WRITE","name":"b","path":"/x"}'),
    );
    const names: string[] = [];
    const onKeepalive = vi.fn();
    const closed = new Promise<void>((resolve) => {
      fs.watch("/x", (e) => { names.push(e.name); }, { withContent: false, onKeepalive, onClose: resolve });
    });

    await closed;
    expect(names).toEqual(["a", "b"]);
    expect(onKeepalive).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when the caller closes the watch", async () => {
    const fs = createWatchHarness(new ReadableStream<Uint8Array>());
    const onClose = vi.fn();
    const onError = vi.fn();
    const handle = fs.watch("/x", () => {}, { withContent: false, onClose, onError });

    await new Promise((r) => setTimeout(r, 20));
    handle.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(onClose).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
