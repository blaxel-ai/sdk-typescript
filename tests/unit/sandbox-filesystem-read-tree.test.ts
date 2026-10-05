import { describe, expect, it, vi } from "vitest";
import { SandboxFileSystem } from "../../@blaxel/core/src/sandbox/filesystem/filesystem.js";
import { FilesystemReadTreeError } from "../../@blaxel/core/src/sandbox/filesystem/index.js";

function harness(paths: string[] = []) {
  const fs = Object.create(SandboxFileSystem.prototype) as SandboxFileSystem;
  const find = vi.fn().mockResolvedValue({ matches: paths.map(path => ({ path, type: "file" })), total: paths.length });
  const read = vi.fn((path: string) => Promise.resolve(`content:${path}`));
  fs.find = find;
  fs.read = read;
  return { fs, find, read };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("SandboxFileSystem.readTree", () => {
  it("asks find for files, one more than maxFiles, with the caller's selection", async () => {
    const { fs, find } = harness();
    await fs.readTree("/root");
    expect(find).toHaveBeenLastCalledWith("/root", { type: "file", maxResults: 101 });
    await fs.readTree("/root", {
      patterns: ["*.json"], excludeDirs: ["dist"], excludeHidden: false, maxFiles: 5, concurrency: 2,
    });
    expect(find).toHaveBeenLastCalledWith("/root", {
      type: "file", patterns: ["*.json"], excludeDirs: ["dist"], excludeHidden: false, maxResults: 6,
    });
  });

  it("returns relative paths in sorted order in a plain object", async () => {
    const { fs, read } = harness(["z.json", "nested/b.json", "__proto__", "a.json"]);
    const files = await fs.readTree("/root/");
    expect(Object.keys(files)).toEqual(["__proto__", "a.json", "nested/b.json", "z.json"]);
    expect(Object.getPrototypeOf(files)).toBe(Object.prototype);
    expect(files["nested/b.json"]).toBe("content:/root/nested/b.json");
    expect(read).toHaveBeenCalledWith("/root/a.json");
  });

  it("rejects with MAX_FILES before reading when more than maxFiles match", async () => {
    const { fs, find, read } = harness(["a", "b", "c"]);
    expect(Object.keys(await fs.readTree("/root", { maxFiles: 3 }))).toEqual(["a", "b", "c"]);
    const error = await fs.readTree("/root", { maxFiles: 2 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FilesystemReadTreeError);
    expect(error).toMatchObject({ code: "MAX_FILES", root: "/root" });
    expect(find).toHaveBeenLastCalledWith("/root", expect.objectContaining({ maxResults: 3 }));
    expect(read).toHaveBeenCalledTimes(3); // only from the first, successful call
  });

  it("rejects a maxFiles that find could not cap and a concurrency below 1 before any request", async () => {
    const { fs, find } = harness();
    await expect(fs.readTree("/root", { maxFiles: 1000 })).rejects.toThrow(RangeError);
    await expect(fs.readTree("/root", { concurrency: 0 })).rejects.toThrow(RangeError);
    expect(find).not.toHaveBeenCalled();
  });

  it("never has more than `concurrency` reads in flight", async () => {
    const { fs, read } = harness(["a", "b", "c", "d", "e"]);
    let inFlight = 0;
    let peak = 0;
    read.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight--;
      return "x";
    });
    await fs.readTree("/root", { concurrency: 2 });
    expect(peak).toBe(2);
  });

  it("wraps a read failure as READ with the path, waits for in-flight reads and starts no more", async () => {
    const { fs, read } = harness(["a", "b", "c", "d"]);
    const slow = deferred<string>();
    const cause = new Error("boom");
    read.mockImplementation((path: string) => path === "/root/a" ? slow.promise : Promise.reject(cause));
    let settled = false;
    const result = fs.readTree("/root", { concurrency: 2 }).finally(() => { settled = true; });
    const outcome = result.catch((e: unknown) => e);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(settled).toBe(false);
    slow.resolve("late");
    const error = await outcome;
    expect(error).toMatchObject({ code: "READ", root: "/root", path: "b", cause, message: "readTree could not read b: boom" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("wraps a discovery failure as DISCOVERY and does not read", async () => {
    const { fs, find, read } = harness();
    const cause = new Error("not found");
    find.mockRejectedValue(cause);
    await expect(fs.readTree("/missing")).rejects.toMatchObject({ code: "DISCOVERY", root: "/missing", cause, message: "readTree discovery failed: not found" });
    expect(read).not.toHaveBeenCalled();
  });
});
