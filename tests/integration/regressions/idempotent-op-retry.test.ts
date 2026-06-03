// Regression: idempotent sandbox-op retry (advances ENG-2682; same mechanism as
// ENG-2680's upload retry, extended to GET-shaped reads/lists).
//
// ENG-2680 made only the UPLOAD path self-heal transient connection resets. But
// the customer's intermittent failures (and the original gist) also hit
// fs.read/ls, drives.list, and process.get — the reads a file viewer/agent makes
// after a sandbox resumes. Those are idempotent, so they now retry transient
// resets too.
//
// The critical guard this test locks in: process.exec is a NON-idempotent POST
// (it creates a process) and must NEVER be retried — retrying it duplicates the
// process, which is exactly the ENG-2340 bug. read-of-a-404 (a real application
// error) must also never be retried.
//
// Drives the real classes through a fake hey-api client. No creds, no network.
import { afterEach, describe, expect, it } from "vitest";
import { SandboxFileSystem } from "../../../@blaxel/core/src/sandbox/filesystem/filesystem.js";
import { SandboxDrive } from "../../../@blaxel/core/src/sandbox/drive/drive.js";
import { SandboxProcess } from "../../../@blaxel/core/src/sandbox/process/process.js";
import { settings } from "../../../@blaxel/core/src/common/settings.js";

// A transport reset shaped like the real failure: top-level "fetch failed"
// wrapping a cause that carries the ECONNRESET code.
function econnreset(): Error {
  return Object.assign(new Error("fetch failed"), {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });
}

const reset = () => {
  throw econnreset();
};
const ok = (data: unknown) => () => ({ response: { ok: true, status: 200 }, data, error: undefined });
const httpErr = (status: number) => () => ({ response: { ok: false, status }, data: undefined, error: { error: "nope" } });
// A 4xx/5xx whose error BODY text contains a transport marker ("GOAWAY"/"ERR_HTTP2").
// Must still be treated as an application error (not retried) because a real HTTP
// status came back — the response-status guard in the classifier handles this.
const httpErrMarker = (status: number) => () => ({ response: { ok: false, status }, data: undefined, error: { error: "upstream stream reset: GOAWAY (ERR_HTTP2)" } });

// Build an instance of `Proto` whose generated-client calls (get/post/put/delete)
// follow `behaviors` by attempt (last entry repeats). A behavior that throws
// simulates a transport reset; one that returns simulates an HTTP response.
function makeInstance<T>(Proto: { prototype: object }, behaviors: Array<() => unknown>): { inst: T; calls: () => number } {
  const inst = Object.create(Proto.prototype) as Record<string, unknown>;
  // forceUrl makes `this.url` resolve with no network/creds; the fake client
  // shadows the prototype `client` getter so calls never hit the wire.
  inst.sandbox = { forceUrl: "http://edge.test", metadata: { name: "t" } };
  let calls = 0;
  const handler = () => {
    const i = calls++;
    const behavior = behaviors[Math.min(i, behaviors.length - 1)];
    return Promise.resolve().then(behavior);
  };
  Object.defineProperty(inst, "client", {
    value: { get: handler, post: handler, put: handler, delete: handler },
    configurable: true,
  });
  return { inst: inst as unknown as T, calls: () => calls };
}

describe("idempotent sandbox-op retry: reads/list self-heal, non-idempotent ops do not", () => {
  afterEach(() => {
    delete settings.config.fsPartRetries;
    delete settings.config.sandboxReadRetries;
  });

  it("fs.read self-heals a transient reset (default-on)", async () => {
    expect(settings.sandboxReadRetries).toBe(5); // idempotent-read budget (higher, for cold-start)
    expect(settings.fsPartRetries).toBe(3); // upload budget stays lower/unchanged
    const { inst, calls } = makeInstance<SandboxFileSystem>(SandboxFileSystem, [reset, reset, ok({ content: "hi" })]);
    await expect(inst.read("/f")).resolves.toBe("hi");
    expect(calls()).toBe(3); // 1 attempt + 2 retries
  });

  it("fs.ls self-heals a transient reset (the file-tree refresh that flaked)", async () => {
    const { inst, calls } = makeInstance<SandboxFileSystem>(SandboxFileSystem, [reset, ok({ files: [], subdirectories: [] })]);
    await expect(inst.ls("/")).resolves.toBeDefined();
    expect(calls()).toBe(2);
  });

  it("drives.list self-heals a transient reset", async () => {
    const { inst, calls } = makeInstance<SandboxDrive>(SandboxDrive, [reset, ok({ mounts: [] })]);
    await expect(inst.list()).resolves.toEqual([]);
    expect(calls()).toBe(2);
  });

  it("process.get self-heals a transient reset (also hardens the wait() poll loop)", async () => {
    const { inst, calls } = makeInstance<SandboxProcess>(SandboxProcess, [reset, ok({ pid: "1", status: "completed" })]);
    await expect(inst.get("1")).resolves.toBeDefined();
    expect(calls()).toBe(2);
  });

  it("does NOT retry a non-transient application error on a read (404)", async () => {
    const { inst, calls } = makeInstance<SandboxFileSystem>(SandboxFileSystem, [httpErr(404)]);
    await expect(inst.read("/missing")).rejects.toBeDefined();
    expect(calls()).toBe(1); // a 404 is not transient: no retry
  });

  it("does NOT retry a 4xx/5xx whose body text contains a reset marker (no over-match)", async () => {
    // The server returned a real HTTP status; even though its error body says
    // "GOAWAY"/"ERR_HTTP2", it must not be retried as a transport reset.
    const { inst, calls } = makeInstance<SandboxFileSystem>(SandboxFileSystem, [httpErrMarker(500)]);
    await expect(inst.read("/x")).rejects.toBeDefined();
    expect(calls()).toBe(1);
  });

  it("fs.readBinary self-heals a transient reset", async () => {
    const { inst, calls } = makeInstance<SandboxFileSystem>(SandboxFileSystem, [reset, ok("bytes")]);
    await expect(inst.readBinary("/b")).resolves.toBeInstanceOf(Blob);
    expect(calls()).toBe(2);
  });

  it("process.list self-heals a transient reset", async () => {
    const { inst, calls } = makeInstance<SandboxProcess>(SandboxProcess, [reset, ok({ processes: [] })]);
    await expect(inst.list()).resolves.toBeDefined();
    expect(calls()).toBe(2);
  });

  it("process.logs self-heals a transient reset", async () => {
    const { inst, calls } = makeInstance<SandboxProcess>(SandboxProcess, [reset, ok({ logs: "hi" })]);
    await expect(inst.logs("1")).resolves.toBe("hi");
    expect(calls()).toBe(2);
  });

  it("uses the higher read budget (5): self-heals after 4 resets", async () => {
    const { inst, calls } = makeInstance<SandboxFileSystem>(SandboxFileSystem, [reset, reset, reset, reset, ok({ content: "ok" })]);
    await expect(inst.read("/deep")).resolves.toBe("ok");
    expect(calls()).toBe(5); // 1 attempt + 4 retries, within the budget of 5
  });

  it("process.exec does NOT retry a transient reset (guards ENG-2340 duplicate-exec)", async () => {
    const { inst, calls } = makeInstance<SandboxProcess>(SandboxProcess, [reset, reset, reset]);
    await expect(inst.exec({ command: "echo hi" } as never)).rejects.toBeDefined();
    expect(calls()).toBe(1); // POST is non-idempotent: exactly one attempt, never retried
  });

  it("idempotent-read retry can be disabled (sandboxReadRetries=0)", async () => {
    settings.config.sandboxReadRetries = 0;
    const { inst, calls } = makeInstance<SandboxFileSystem>(SandboxFileSystem, [reset]);
    await expect(inst.read("/f")).rejects.toBeDefined();
    expect(calls()).toBe(1); // retry disabled: exactly one attempt
  });
});
