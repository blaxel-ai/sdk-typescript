import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the generated client so the snapshot helpers can be scripted and their
// requests inspected. Both the workspace resource and the sandbox
// sub-resource import the same module, so vitest rewires both.
vi.mock("../../@blaxel/core/src/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../@blaxel/core/src/client/index.js")>();
  return {
    ...actual,
    createSnapshot: vi.fn(),
    getSnapshot: vi.fn(),
    listSnapshots: vi.fn(),
    deleteSnapshot: vi.fn(),
    forkSnapshot: vi.fn(),
    listSandboxSnapshots: vi.fn(),
    deleteSandboxSnapshot: vi.fn(),
    restoreSandboxSnapshot: vi.fn(),
  };
});

import {
  createSnapshot,
  deleteSandboxSnapshot,
  deleteSnapshot,
  forkSnapshot,
  getSnapshot,
  listSandboxSnapshots,
  listSnapshots,
  restoreSandboxSnapshot,
} from "../../@blaxel/core/src/client/index.js";
import { SandboxInstance } from "../../@blaxel/core/src/sandbox/sandbox.js";
import { Snapshot } from "../../@blaxel/core/src/snapshot/index.js";

const mocked = {
  create: vi.mocked(createSnapshot),
  get: vi.mocked(getSnapshot),
  list: vi.mocked(listSnapshots),
  delete: vi.mocked(deleteSnapshot),
  fork: vi.mocked(forkSnapshot),
  nestedList: vi.mocked(listSandboxSnapshots),
  nestedDelete: vi.mocked(deleteSandboxSnapshot),
  nestedRestore: vi.mocked(restoreSandboxSnapshot),
};

const instance = () =>
  new SandboxInstance({ metadata: { name: "my-sandbox" }, spec: { runtime: {} } } as never);

const call = (mock: { mock: { calls: unknown[][] } }) => mock.mock.calls[0][0] as never;

describe("Snapshot", () => {
  afterEach(() => {
    for (const mock of Object.values(mocked)) mock.mockReset();
  });

  it("create() only needs a source name", async () => {
    mocked.create.mockResolvedValueOnce({
      data: { name: "my-snapshot", source: { kind: "sandbox", name: "my-sandbox" } },
    } as never);

    const snapshot = await Snapshot.create({ name: "my-snapshot", source: { name: "my-sandbox" } });

    expect((call(mocked.create) as { body: Record<string, unknown> }).body).toEqual({
      name: "my-snapshot",
      source: { name: "my-sandbox" },
    });
    expect(snapshot.name).toBe("my-snapshot");
    expect(snapshot.source?.kind).toBe("sandbox");
  });

  it("create() lets the server name the snapshot when no name is given", async () => {
    mocked.create.mockResolvedValueOnce({ data: { name: "generated" } } as never);

    await Snapshot.create({ source: { name: "my-sandbox" } });

    expect((call(mocked.create) as { body: Record<string, unknown> }).body).toEqual({
      source: { name: "my-sandbox" },
    });
  });

  it("list() paginates over the workspace's snapshots", async () => {
    mocked.list.mockResolvedValueOnce({
      data: { data: [{ name: "my-snapshot" }], meta: { hasMore: false } },
    } as never);

    const page = await Snapshot.list({ limit: 10 });

    expect((call(mocked.list) as { query: { limit: number } }).query.limit).toBe(10);
    expect(page.data.map((snapshot) => snapshot.name)).toEqual(["my-snapshot"]);
  });

  it("delete() and fork() address the snapshot by id, never by its per-sandbox name", async () => {
    mocked.get.mockResolvedValueOnce({ data: { id: "snap-uuid", name: "my-snapshot" } } as never);
    mocked.fork.mockResolvedValueOnce({ data: { name: "copy", type: "sandbox" } } as never);
    mocked.delete.mockResolvedValueOnce({ data: undefined } as never);

    const snapshot = await Snapshot.get("snap-uuid");
    const fork = await snapshot.fork("copy");
    await snapshot.delete();

    expect((call(mocked.get) as { path: { snapshotName: string } }).path.snapshotName).toBe("snap-uuid");
    const forkOptions = call(mocked.fork) as { path: { snapshotName: string }; body: Record<string, unknown> };
    expect(forkOptions.path.snapshotName).toBe("snap-uuid");
    expect(forkOptions.body).toEqual({ targetName: "copy", targetType: "sandbox" });
    expect(fork).toEqual({ name: "copy", type: "sandbox" });
    expect((call(mocked.delete) as { path: { snapshotName: string } }).path.snapshotName).toBe("snap-uuid");
  });

  it("fork() forwards the envs the fork should run with", async () => {
    mocked.get.mockResolvedValueOnce({ data: { name: "my-snapshot" } } as never);
    mocked.fork.mockResolvedValueOnce({ data: { name: "copy", type: "sandbox" } } as never);

    const snapshot = await Snapshot.get("my-snapshot");
    await snapshot.fork("copy", { envs: [{ name: "FOO", value: "bar" }], port: 3000 });

    expect((call(mocked.fork) as { body: Record<string, unknown> }).body).toEqual({
      targetName: "copy",
      targetType: "sandbox",
      port: 3000,
      envs: [{ name: "FOO", value: "bar" }],
    });
  });
});

describe("sandbox.snapshots", () => {
  afterEach(() => {
    for (const mock of Object.values(mocked)) mock.mockReset();
  });

  it("create() captures the sandbox as the source", async () => {
    mocked.create.mockResolvedValueOnce({ data: { name: "my-snapshot" } } as never);

    const snapshot = await instance().snapshots.create("my-snapshot");

    expect((call(mocked.create) as { body: Record<string, unknown> }).body).toEqual({
      name: "my-snapshot",
      source: { name: "my-sandbox", kind: "sandbox" },
    });
    expect(snapshot).toBeInstanceOf(Snapshot);
  });

  it("list(), delete() and restore() go through the sandbox's own routes", async () => {
    mocked.nestedList.mockResolvedValueOnce({ data: [{ name: "my-snapshot" }] } as never);
    mocked.nestedDelete.mockResolvedValueOnce({ data: undefined } as never);
    mocked.nestedRestore.mockResolvedValueOnce({ data: { name: "my-sandbox" } } as never);

    const list = await instance().snapshots.list();
    await instance().snapshots.delete("my-snapshot");
    await instance().snapshots.restore("my-snapshot");

    expect(list.map((snapshot) => snapshot.name)).toEqual(["my-snapshot"]);
    expect((call(mocked.nestedList) as { path: { sandboxName: string } }).path.sandboxName).toBe("my-sandbox");
    expect((call(mocked.nestedDelete) as { path: Record<string, string> }).path).toEqual({
      sandboxName: "my-sandbox",
      snapshotId: "my-snapshot",
    });
    expect((call(mocked.nestedRestore) as { path: Record<string, string> }).path).toEqual({
      sandboxName: "my-sandbox",
      snapshotId: "my-snapshot",
    });
  });

  it("get() resolves a name among the sandbox's snapshots instead of the id-only workspace route", async () => {
    mocked.nestedList.mockResolvedValue({ data: [{ id: "snap-uuid", name: "my-snapshot" }] } as never);

    const byName = await instance().snapshots.get("my-snapshot");
    const byId = await instance().snapshots.get("snap-uuid");

    expect(byName.id).toBe("snap-uuid");
    expect(byId.name).toBe("my-snapshot");
    expect(mocked.get).not.toHaveBeenCalled();
    await expect(instance().snapshots.get("unknown")).rejects.toThrow("not found");
  });
});
