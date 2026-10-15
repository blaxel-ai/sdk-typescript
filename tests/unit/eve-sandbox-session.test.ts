import { SandboxInstance } from "@blaxel/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBlaxelEveSession } from "../../@blaxel/eve-sandbox/src/session.js";

type ProcessResult = {
  exitCode: number;
  pid: string;
  status: "completed" | "killed" | "running";
  stderr: string;
  stdout: string;
};

describe("Blaxel eve session", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps eve commands, files, paths, removal, and network policy", async () => {
    const files = new Map<string, Uint8Array>();
    const processResult: ProcessResult = {
      exitCode: 0,
      pid: "process-1",
      status: "completed",
      stderr: "",
      stdout: "hello",
    };
    const processExec = vi.fn((input: { command: string; workingDir?: string }) => {
      void input;
      return Promise.resolve(processResult);
    });
    const sandbox = {
      metadata: { name: "eve-session-test" },
      fs: {
        mkdir: () => Promise.resolve(),
        readBinary(filePath: string) {
          const value = files.get(filePath);
          if (!value) throw Object.assign(new Error("missing"), { code: 404 });
          return Promise.resolve(new Blob([new Uint8Array(value)]));
        },
        rm(filePath: string) {
          if (!files.delete(filePath)) throw Object.assign(new Error("missing"), { code: 404 });
          return Promise.resolve();
        },
        write(filePath: string, content: string) {
          files.set(filePath, new TextEncoder().encode(content));
          return Promise.resolve();
        },
        writeBinary(filePath: string, content: Uint8Array) {
          files.set(filePath, new Uint8Array(content));
          return Promise.resolve();
        },
      },
      process: {
        exec: processExec,
        get() {
          return Promise.resolve(processResult);
        },
        kill: () => Promise.resolve(),
        streamLogs(
          _pid: string,
          handlers: { onStdout?: (value: string) => void; onStderr?: (value: string) => void },
        ) {
          handlers.onStdout?.("hello");
          return { close() {}, wait: () => Promise.resolve() };
        },
      },
    } as unknown as SandboxInstance;
    const updateNetwork = vi
      .spyOn(SandboxInstance, "updateNetwork")
      .mockResolvedValue(sandbox);
    const session = createBlaxelEveSession({ id: "session-key", sandbox });

    expect(session.id).toBe("session-key");
    expect(session.resolvePath("notes/a.txt")).toBe("/workspace/notes/a.txt");
    await session.writeTextFile({ path: "notes/a.txt", content: "one\ntwo\nthree\n" });
    expect(await session.readTextFile({ path: "notes/a.txt", startLine: 2, endLine: 2 })).toBe(
      "two\n",
    );
    await session.writeBinaryFile({ path: "data.bin", content: new Uint8Array([0, 1, 255]) });
    expect(await session.readBinaryFile({ path: "data.bin" })).toEqual(
      new Uint8Array([0, 1, 255]),
    );
    expect(await session.readFile({ path: "missing.txt" })).toBeNull();
    await session.removePath({ path: "data.bin" });
    await expect(session.removePath({ path: "data.bin", force: true })).resolves.toBeUndefined();

    expect(await session.run({ command: "printf hello" })).toEqual({
      exitCode: 0,
      stdout: "hello",
      stderr: "",
    });
    await session.run({ command: "pwd", workingDirectory: "notes" });
    expect(processExec).toHaveBeenLastCalledWith(
      expect.objectContaining({ workingDir: "/workspace/notes" }),
    );
    await session.setNetworkPolicy({ allow: ["github.com"] });
    expect(updateNetwork).toHaveBeenCalledWith("eve-session-test", {
      network: { proxy: { allowedDomains: ["github.com"], routing: [] } },
    });
  });

  it("kills a provider process when unread output exceeds its bound", async () => {
    const kill = vi.fn(() => Promise.resolve({}));
    const sandbox = {
      metadata: { name: "eve-overflow-test" },
      process: {
        exec: vi.fn(() => Promise.resolve({
          exitCode: 0,
          pid: "overflow-process",
          status: "running" as const,
          stderr: "",
          stdout: "",
        })),
        get: vi.fn(),
        kill,
        streamLogs(
          _pid: string,
          handlers: { onStdout?: (value: string) => void },
        ) {
          handlers.onStdout?.("too-much-output");
          return { close() {}, wait: () => Promise.resolve() };
        },
      },
    } as unknown as SandboxInstance;
    const session = createBlaxelEveSession({
      id: "overflow-session",
      processOutputBufferBytes: 4,
      sandbox,
    });

    await expect(session.run({ command: "generate-output" })).rejects.toThrow(
      /output exceeded the 4-byte buffer/,
    );
    expect(kill).toHaveBeenCalledWith("overflow-process");
  });
});
