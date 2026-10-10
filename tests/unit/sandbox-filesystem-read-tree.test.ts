import { describe, expect, it, vi } from "vitest";
import { SandboxFileSystem } from "../../@blaxel/core/src/sandbox/filesystem/filesystem.js";

type TreeFile = { path: string; name: string; content?: string };

function harness(body: unknown, status = 200) {
  const fs = Object.create(SandboxFileSystem.prototype) as SandboxFileSystem;
  const get = vi.fn().mockResolvedValue({
    response: new Response(null, { status }),
    data: status < 300 ? body : undefined,
    error: status < 300 ? undefined : body,
  });
  Object.defineProperty(fs, "client", { value: { get } });
  Object.defineProperty(fs, "url", { value: "http://sandbox.local" });
  return { fs, get };
}

function tree(path: string, files: TreeFile[], recursive = true) {
  return { path, name: path.split("/").pop(), files, subdirectories: [], ...(recursive ? { recursive } : {}) };
}

describe("SandboxFileSystem.readTree", () => {
  it("reads the whole tree with contents in one request", async () => {
    const { fs, get } = harness(tree("/root", []));
    await fs.readTree("/root");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenLastCalledWith({
      url: "/filesystem/tree/{path}",
      path: { path: "/root" },
      query: { recursive: true, content: true },
      baseUrl: "http://sandbox.local",
    });
  });

  it("passes the selection and limits as query parameters", async () => {
    const { fs, get } = harness(tree("/root", []));
    await fs.readTree("/root", {
      patterns: ["*.json", "*.md"], excludeDirs: ["node_modules", "dist"], excludeHidden: false, maxFiles: 5, maxBytes: 1024,
    });
    expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ query: {
      recursive: true, content: true, patterns: "*.json,*.md", excludeDirs: "node_modules,dist", excludeHidden: false, maxFiles: 5, maxBytes: 1024,
    } }));
  });

  it("returns sorted relative paths in a plain object and skips entries without content", async () => {
    const { fs } = harness(tree("/root", [
      { path: "/root/z.json", name: "z.json", content: "z" },
      { path: "/root/nested/b.json", name: "b.json", content: "" },
      { path: "/root/__proto__", name: "__proto__", content: "p" },
      { path: "/root/dir-link", name: "dir-link" },
      { path: "/root/a.json", name: "a.json", content: "a" },
    ]));
    const files = await fs.readTree("/root/");
    expect(Object.keys(files)).toEqual(["__proto__", "a.json", "nested/b.json", "z.json"]);
    expect(Object.getPrototypeOf(files)).toBe(Object.prototype);
    expect(files["nested/b.json"]).toBe("");
  });

  it("strips the root prefix when the root is /", async () => {
    const { fs } = harness(tree("/", [{ path: "/a.json", name: "a.json", content: "a" }]));
    expect(await fs.readTree("/")).toEqual({ "a.json": "a" });
  });

  it("fails instead of returning a one-level listing from an older sandbox API", async () => {
    const { fs } = harness(tree("/root", [{ path: "/root/a.json", name: "a.json" }], false));
    await expect(fs.readTree("/root")).rejects.toThrow("readTree needs a newer sandbox API");
  });

  it("surfaces a limit or missing-path error from the API", async () => {
    const { fs } = harness({ error: "error getting file system tree: tree read limit exceeded: more than 5 files match under /root" }, 422);
    await expect(fs.readTree("/root", { maxFiles: 5 })).rejects.toMatchObject({ status: 422 });
  });
});
