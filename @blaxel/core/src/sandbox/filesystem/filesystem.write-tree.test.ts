import { createClient } from "@hey-api/client-fetch";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Directory, GetFilesystemTreeByPathResponse, PutFilesystemTreeByPathResponse } from "../client/index.js";
import { SandboxProcess } from "../process/process.js";
import { SandboxFileSystem } from "./filesystem.js";

const directory: Directory = {
  name: "tree",
  path: "/tmp/tree",
  files: [{ name: "root.txt", path: "/tmp/tree/root.txt", size: 5, permissions: "0644", owner: "root", group: "root", lastModified: "2026-10-07T00:00:00Z" }],
  subdirectories: [{ name: "nested", path: "/tmp/tree/nested" }],
};

function filesystemWithResponse(status: number, body: unknown) {
  const sandbox = { metadata: { name: "filesystem-contract" }, spec: {}, forceUrl: "https://sandbox.test", headers: {} };
  const filesystem = new SandboxFileSystem(sandbox, new SandboxProcess(sandbox));
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })));
  const client = createClient({ fetch, headers: { "x-session": "session-header" } });
  Object.defineProperty(filesystem, "client", { value: client });
  return { filesystem, fetch };
}

describe("SandboxFileSystem.writeTree", () => {
  it("returns a Directory from one authenticated tree write", async () => {
    expectTypeOf<ReturnType<SandboxFileSystem["writeTree"]>>().toEqualTypeOf<Promise<Directory>>();
    expectTypeOf<PutFilesystemTreeByPathResponse>().toEqualTypeOf<Directory>();
    expectTypeOf<GetFilesystemTreeByPathResponse>().toEqualTypeOf<Directory>();
    const { filesystem, fetch } = filesystemWithResponse(200, directory);
    const files = [{ path: "root.txt", content: "hello" }, { path: "nested/child.txt", content: "nested content" }];

    const result = await filesystem.writeTree(files, "/tmp/tree");

    expect(result).toEqual(directory);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    const request = new Request(input, init);
    expect(request.method).toBe("PUT");
    expect(request.url).toBe("https://sandbox.test/filesystem/tree/%2Ftmp%2Ftree");
    expect(request.headers.get("x-session")).toBe("session-header");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.json()).toEqual({ files: { "root.txt": "hello", "nested/child.txt": "nested content" } });
  });

  it("keeps the default destination path", async () => {
    const { filesystem, fetch } = filesystemWithResponse(200, directory);
    await expect(filesystem.writeTree([{ path: "root.txt", content: "hello" }])).resolves.toEqual(directory);
    expect(new Request(...fetch.mock.calls[0]).url).toBe("https://sandbox.test/filesystem/tree/");
  });

  it("rejects an API error instead of resolving undefined", async () => {
    const { filesystem, fetch } = filesystemWithResponse(422, { error: "destination is not a directory" });
    await expect(filesystem.writeTree([{ path: "root.txt", content: "hello" }], "/tmp/tree"))
      .rejects.toThrow("destination is not a directory");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
