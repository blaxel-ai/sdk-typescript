import { SandboxInstance } from "@blaxel/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { blaxel } from "../../@blaxel/eve-sandbox/src/index.js";

type SandboxCreateInput = NonNullable<
  Parameters<typeof SandboxInstance.createIfNotExists>[0]
>;

class FakeSandbox {
  readonly files = new Map<string, Uint8Array>();
  readonly metadata: { name: string };
  readonly fs = {
    mkdir: vi.fn(() => Promise.resolve({})),
    readBinary: vi.fn((path: string) => {
      const value = this.files.get(path);
      if (!value) throw Object.assign(new Error("missing"), { code: 404 });
      return Promise.resolve(new Blob([new Uint8Array(value)]));
    }),
    rm: vi.fn((path: string) => {
      this.files.delete(path);
      return Promise.resolve({});
    }),
    write: vi.fn((path: string, content: string) => {
      this.files.set(path, new TextEncoder().encode(content));
      return Promise.resolve({});
    }),
    writeBinary: vi.fn((path: string, content: Uint8Array) => {
      this.files.set(path, new Uint8Array(content));
      return Promise.resolve({});
    }),
  };
  readonly process = {
    exec: vi.fn(() => Promise.resolve({
      exitCode: 0,
      pid: "process-1",
      status: "completed" as const,
      stderr: "",
      stdout: "",
    })),
    get: vi.fn(() => Promise.resolve({
      exitCode: 0,
      pid: "process-1",
      status: "completed" as const,
      stderr: "",
      stdout: "",
    })),
    kill: vi.fn(() => Promise.resolve({})),
    streamLogs: vi.fn(() => ({ close() {}, wait: () => Promise.resolve() })),
  };
  readonly delete = vi.fn(() => {
    resources.delete(this.metadata.name);
    return Promise.resolve({});
  });

  constructor(name: string) {
    this.metadata = { name };
  }
}

const resources = new Map<string, FakeSandbox>();

describe("Blaxel eve durable lifecycle", () => {
  afterEach(() => {
    resources.clear();
    vi.restoreAllMocks();
  });

  it("creates and reconnects durable sessions using generally available APIs", async () => {
    const create = vi.spyOn(SandboxInstance, "createIfNotExists").mockImplementation((input) => {
      const name = sandboxInputName(input);
      if (!name) throw new Error("name required");
      const existing = resources.get(name);
      if (existing) return Promise.resolve(existing as unknown as SandboxInstance);
      const sandbox = new FakeSandbox(name);
      resources.set(name, sandbox);
      return Promise.resolve(sandbox as unknown as SandboxInstance);
    });
    vi.spyOn(SandboxInstance, "get").mockImplementation((name) => {
      const sandbox = resources.get(name);
      if (!sandbox) throw Object.assign(new Error("missing"), { code: 404 });
      return Promise.resolve(sandbox as unknown as SandboxInstance);
    });
    const updateMetadata = vi
      .spyOn(SandboxInstance, "updateMetadata")
      .mockImplementation((name) => {
        return Promise.resolve(resources.get(name) as unknown as SandboxInstance);
      });

    const firstBackend = blaxel({ image: "blaxel/base-image:latest" });
    const firstHandle = await firstBackend.create({
      templateKey: null,
      sessionKey: "durable-session",
      runtimeContext: { appRoot: "/app" },
      tags: { ["agent-".repeat(20)]: "researcher-".repeat(20) },
    });

    await firstHandle.session.writeTextFile({
      path: "durable/session.txt",
      content: "persists-across-backend-instances",
    });
    const state = await firstHandle.captureState();
    await firstHandle.shutdown();

    expect(create).toHaveBeenCalledTimes(1);
    const firstCreate = create.mock.calls[0];
    if (!firstCreate) throw new Error("expected a sandbox create");
    const createInput = firstCreate[0];
    const sandboxName = sandboxInputName(createInput);
    expect(sandboxName?.length).toBeLessThanOrEqual(49);
    if (!("name" in createInput)) throw new Error("expected sandbox create options");
    expect(
      Object.entries(createInput.labels ?? {}).every(
        ([key, value]) => key.length <= 63 && value.length <= 63,
      ),
    ).toBe(true);

    const secondBackend = blaxel({ image: "blaxel/base-image:latest" });
    const reconnected = await secondBackend.create({
      templateKey: null,
      sessionKey: state.sessionKey,
      existingMetadata: state.metadata,
      runtimeContext: { appRoot: "/different-process" },
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(updateMetadata).toHaveBeenCalledTimes(1);
    const reconnectMetadata = updateMetadata.mock.calls[0];
    if (!reconnectMetadata) throw new Error("expected a metadata update");
    expect(
      Object.entries(reconnectMetadata[1].labels ?? {}).every(
        ([key, value]) => key.length <= 63 && value.length <= 63,
      ),
    ).toBe(true);
    expect((await reconnected.captureState()).metadata).toEqual(state.metadata);
    expect(await reconnected.session.readTextFile({ path: "durable/session.txt" })).toBe(
      "persists-across-backend-instances",
    );
  });

  it("rejects eve template prewarming with actionable GA setup guidance", async () => {
    const create = vi.spyOn(SandboxInstance, "createIfNotExists");
    const backend = blaxel({ image: "blaxel/base-image:latest" });
    const guidance = /custom Blaxel image.*omit eve bootstrap\(\).*onSession\(\)/s;

    await expect(
      backend.prewarm({
        templateKey: "template-key",
        runtimeContext: { appRoot: "/app" },
        seedFiles: [{ path: "seed.txt", content: "seeded" }],
      }),
    ).rejects.toThrow(guidance);

    await expect(
      backend.create({
        templateKey: "template-key",
        sessionKey: "template-session",
        runtimeContext: { appRoot: "/app" },
      }),
    ).rejects.toThrow(guidance);
    expect(create).not.toHaveBeenCalled();
  });
});

function sandboxInputName(input: SandboxCreateInput): string | undefined {
  if ("name" in input && typeof input.name === "string") return input.name;
  if ("metadata" in input) return input.metadata.name;
  return undefined;
}
