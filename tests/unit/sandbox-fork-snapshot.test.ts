import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the generated client so the fork/snapshot helpers can be scripted and
// their request bodies inspected. sandbox.ts imports the same module, so
// vitest rewires both.
vi.mock("../../@blaxel/core/src/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../@blaxel/core/src/client/index.js")>();
  return {
    ...actual,
    forkSandbox: vi.fn(),
    createSandboxSnapshot: vi.fn(),
    listSandboxSnapshots: vi.fn(),
    deleteSandboxSnapshot: vi.fn(),
  };
});

import {
  createSandboxSnapshot,
  deleteSandboxSnapshot,
  forkSandbox,
  listSandboxSnapshots,
} from "../../@blaxel/core/src/client/index.js";
import { SandboxInstance } from "../../@blaxel/core/src/sandbox/sandbox.js";

const mockedFork = vi.mocked(forkSandbox);
const mockedSnapshot = vi.mocked(createSandboxSnapshot);
const mockedListSnapshots = vi.mocked(listSandboxSnapshots);
const mockedDeleteSnapshot = vi.mocked(deleteSandboxSnapshot);

const instance = () =>
  new SandboxInstance({ metadata: { name: "my-sandbox" }, spec: { runtime: {} } } as never);

const call = (mock: { mock: { calls: unknown[][] } }) => mock.mock.calls[0][0] as never;

describe("SandboxInstance fork/snapshot helpers", () => {
  afterEach(() => {
    mockedFork.mockReset();
    mockedSnapshot.mockReset();
    mockedListSnapshots.mockReset();
    mockedDeleteSnapshot.mockReset();
  });

  it("fork() defaults to a sandbox target and passes the source name in the path", async () => {
    mockedFork.mockResolvedValueOnce({ data: { name: "copy", type: "sandbox" } } as never);

    const result = await instance().fork("copy");

    const options = call(mockedFork) as { path: { sandboxName: string }; body: Record<string, unknown> };
    expect(options.path.sandboxName).toBe("my-sandbox");
    expect(options.body).toEqual({ targetName: "copy", targetType: "sandbox" });
    expect(result).toEqual({ name: "copy", type: "sandbox" });
  });

  it("fork() forwards application options and snapshotId", async () => {
    mockedFork.mockResolvedValueOnce({ data: { name: "my-app", type: "application" } } as never);

    await instance().fork("my-app", {
      targetType: "application",
      traffic: 100,
      port: 8080,
      customDomain: "app.example.com",
      snapshotId: "snap_abc123",
    });

    const options = call(mockedFork) as { body: Record<string, unknown> };
    expect(options.body).toEqual({
      targetName: "my-app",
      targetType: "application",
      traffic: 100,
      port: 8080,
      customDomain: "app.example.com",
      snapshotId: "snap_abc123",
    });
  });

  it("snapshot() sends the optional name and returns the created snapshot", async () => {
    mockedSnapshot.mockResolvedValueOnce({ data: { id: "snap_1", name: "before" } } as never);

    const snap = await instance().snapshot("before");

    const options = call(mockedSnapshot) as { path: { sandboxName: string }; body: { name?: string } };
    expect(options.path.sandboxName).toBe("my-sandbox");
    expect(options.body).toEqual({ name: "before" });
    expect(snap).toEqual({ id: "snap_1", name: "before" });
  });

  it("snapshot() omits the body name when none is provided", async () => {
    mockedSnapshot.mockResolvedValueOnce({ data: { id: "snap_1" } } as never);

    await instance().snapshot();

    const options = call(mockedSnapshot) as { body: { name?: string } };
    expect(options.body).toEqual({});
  });

  it("listSnapshots() and deleteSnapshot() target the right sandbox", async () => {
    mockedListSnapshots.mockResolvedValueOnce({ data: [{ id: "snap_1" }] } as never);
    mockedDeleteSnapshot.mockResolvedValueOnce({ data: undefined } as never);

    const list = await instance().listSnapshots();
    await instance().deleteSnapshot("snap_1");

    expect((call(mockedListSnapshots) as { path: { sandboxName: string } }).path.sandboxName).toBe(
      "my-sandbox",
    );
    const delOptions = call(mockedDeleteSnapshot) as {
      path: { sandboxName: string; snapshotId: string };
    };
    expect(delOptions.path).toEqual({ sandboxName: "my-sandbox", snapshotId: "snap_1" });
    expect(list).toEqual([{ id: "snap_1" }]);
  });
});
