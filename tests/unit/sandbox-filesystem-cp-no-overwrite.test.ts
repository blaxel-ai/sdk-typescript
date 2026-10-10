import { describe, expect, it, vi } from "vitest";
import { SandboxFileExistsError, SandboxFileSystem } from "@blaxel/core";

type Reply = { status: number; data?: unknown; error?: unknown };

function harness(reply: Reply = { status: 200, data: { message: "Files copied" } }) {
  const filesystem = Object.create(SandboxFileSystem.prototype) as SandboxFileSystem;
  const post = vi.fn().mockResolvedValue({
    response: new Response(null, { status: reply.status }),
    data: reply.data,
    error: reply.error,
  });
  const exec = vi.fn().mockResolvedValue({ pid: "pid-1" });
  const wait = vi.fn().mockResolvedValue({ status: "completed", exitCode: 0, logs: "" });
  Object.defineProperty(filesystem, "client", { value: { post } });
  Object.defineProperty(filesystem, "url", { value: "http://sandbox.local" });
  Object.defineProperty(filesystem, "process", { value: { exec, wait } });
  return { filesystem, post, exec, wait };
}

describe("SandboxFileSystem.cp noOverwrite", () => {
  it.each([undefined, false])("keeps the default cp -r process path: %s", async noOverwrite => {
    const { filesystem, post, exec, wait } = harness();
    expect(await filesystem.cp("source", "destination", { noOverwrite })).toEqual({ message: "Files copied", source: "source", destination: "destination" });
    expect(exec).toHaveBeenCalledExactlyOnceWith({ command: "cp -r 'source' 'destination'" });
    expect(wait).toHaveBeenCalledExactlyOnceWith("pid-1", { maxWait: 180000, interval: 100 });
    expect(post).not.toHaveBeenCalled();
  });

  it("copies in one request to the copy endpoint, without a process", async () => {
    const { filesystem, post, exec } = harness();
    const source = "-source ' ; $(touch BAD)\nユニコード";
    const destination = "/tmp/destination";
    expect(await filesystem.cp(source, destination, { noOverwrite: true })).toEqual({ message: "Files copied", source, destination });
    expect(post).toHaveBeenCalledExactlyOnceWith({
      url: "/filesystem-copy",
      body: { source, destination, noOverwrite: true },
      headers: { "Content-Type": "application/json" },
      baseUrl: "http://sandbox.local",
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("throws SandboxFileExistsError on 409 FILE_ALREADY_EXISTS", async () => {
    const error = { error: "error copying destination container: file exists", code: "FILE_ALREADY_EXISTS" };
    const { filesystem } = harness({ status: 409, error });
    const thrown = await filesystem.cp("original-source", "container", { noOverwrite: true }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(SandboxFileExistsError);
    expect(thrown).toMatchObject({
      name: "SandboxFileExistsError", code: "FILE_ALREADY_EXISTS", source: "original-source", destination: "container", cause: error,
      message: "Could not copy original-source to container: destination already exists",
    });
  });

  it("fails closed on an older sandbox API without the copy endpoint", async () => {
    const { filesystem, exec } = harness({ status: 404, error: "404 page not found" });
    await expect(filesystem.cp("src", "dst", { noOverwrite: true })).rejects.toThrow("needs a newer sandbox API");
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    { status: 409, error: { error: "conflict without a code" } },
    { status: 422, error: { error: "error copying destination dst: no such file or directory" } },
    { status: 400, error: { error: "bad request" } },
  ])("surfaces other API errors as ResponseError, not a conflict: %j", async reply => {
    const { filesystem } = harness(reply);
    const thrown = await filesystem.cp("src", "dst", { noOverwrite: true }).catch((e: unknown) => e);
    expect(thrown).not.toBeInstanceOf(SandboxFileExistsError);
    expect(thrown).toMatchObject({ status: reply.status });
  });

  it.each([["", "dst"], ["src", ""]])("rejects empty paths before any request: %j", async (source, destination) => {
    const { filesystem, post } = harness();
    await expect(filesystem.cp(source, destination, { noOverwrite: true })).rejects.toThrow(RangeError);
    expect(post).not.toHaveBeenCalled();
  });

  it("does not retry a failed request", async () => {
    const { filesystem, post } = harness();
    const failure = new Error("socket hang up");
    post.mockRejectedValueOnce(failure);
    await expect(filesystem.cp("src", "dst", { noOverwrite: true })).rejects.toBe(failure);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
