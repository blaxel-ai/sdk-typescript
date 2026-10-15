import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the generated client so the archive helpers can be scripted and the
// sandbox reads they poll can be sequenced. sandbox.ts imports the same module,
// so vitest rewires both.
vi.mock("../../../@blaxel/core/src/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../@blaxel/core/src/client/index.js")>();
  return {
    ...actual,
    archiveSandbox: vi.fn(),
    unarchiveSandbox: vi.fn(),
    getSandbox: vi.fn(),
  };
});

import { archiveSandbox, getSandbox, unarchiveSandbox } from "../../../@blaxel/core/src/client/index.js";
import { SandboxInstance } from "../../../@blaxel/core/src/sandbox/sandbox.js";

const mockedArchive = vi.mocked(archiveSandbox);
const mockedUnarchive = vi.mocked(unarchiveSandbox);
const mockedGet = vi.mocked(getSandbox);

const record = (status: string) => ({
  metadata: { name: "my-sandbox" },
  spec: { runtime: {} },
  status,
});

const instance = () => new SandboxInstance(record("DEPLOYED") as never);

const path = (mock: { mock: { calls: unknown[][] } }) =>
  (mock.mock.calls[0][0] as { path: { sandboxName: string } }).path.sandboxName;

describe("SandboxInstance archive/unarchive", () => {
  afterEach(() => {
    mockedArchive.mockReset();
    mockedUnarchive.mockReset();
    mockedGet.mockReset();
  });

  it("archive() waits until the filesystem is stored", async () => {
    mockedArchive.mockResolvedValueOnce({ data: record("ARCHIVING") } as never);
    mockedGet
      .mockResolvedValueOnce({ data: record("ARCHIVING") } as never)
      .mockResolvedValueOnce({ data: record("ARCHIVED") } as never);

    const sandbox = instance();
    const result = await sandbox.archive({ interval: 0 });

    expect(path(mockedArchive)).toBe("my-sandbox");
    expect(result).toBe(sandbox);
    expect(sandbox.status).toBe("ARCHIVED");
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("archive({ wait: false }) returns as soon as the export is launched", async () => {
    mockedArchive.mockResolvedValueOnce({ data: record("ARCHIVING") } as never);

    const sandbox = instance();
    await sandbox.archive({ wait: false });

    expect(sandbox.status).toBe("ARCHIVING");
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("archive() throws when the sandbox stops archiving without being archived", async () => {
    // A failed export gives the sandbox back, so it never reaches ARCHIVED.
    mockedArchive.mockResolvedValueOnce({ data: record("ARCHIVING") } as never);
    mockedGet.mockResolvedValue({ data: record("FAILED") } as never);

    await expect(instance().archive({ interval: 0 })).rejects.toThrow(/is FAILED/);
  });

  it("archive() tolerates the status it starts from", async () => {
    // The export is launched before the record moves, so the sandbox is still
    // read as DEPLOYED for a moment.
    mockedArchive.mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
    mockedGet
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never)
      .mockResolvedValueOnce({ data: record("ARCHIVING") } as never)
      .mockResolvedValueOnce({ data: record("ARCHIVED") } as never);

    const sandbox = instance();
    await sandbox.archive({ interval: 0 });

    expect(sandbox.status).toBe("ARCHIVED");
  });

  it("archive() fails instead of waiting when the sandbox is given back deployed", async () => {
    // A failed export hands the sandbox back as DEPLOYED: once it has started
    // archiving, reading DEPLOYED again means it is over, not still running.
    mockedArchive.mockResolvedValueOnce({ data: record("ARCHIVING") } as never);
    mockedGet
      .mockResolvedValueOnce({ data: record("ARCHIVING") } as never)
      .mockResolvedValue({ data: record("DEPLOYED") } as never);

    await expect(instance().archive({ interval: 0 })).rejects.toThrow(/is DEPLOYED/);
  });

  it("unarchive() fails instead of waiting when the sandbox stays archived", async () => {
    mockedUnarchive.mockResolvedValueOnce({ data: record("UNARCHIVING") } as never);
    mockedGet
      .mockResolvedValueOnce({ data: record("UNARCHIVING") } as never)
      .mockResolvedValue({ data: record("ARCHIVED") } as never);

    await expect(SandboxInstance.unarchive("my-sandbox", { interval: 0 })).rejects.toThrow(/is ARCHIVED/);
  });

  it("archive() gives up once maxWait is spent", async () => {
    mockedArchive.mockResolvedValueOnce({ data: record("ARCHIVING") } as never);
    mockedGet.mockResolvedValue({ data: record("ARCHIVING") } as never);

    await expect(instance().archive({ interval: 0, maxWait: 0 })).rejects.toThrow(/still ARCHIVING/);
  });

  it("archive() does not wait for the first move past maxWait", async () => {
    // A sandbox that never leaves DEPLOYED is tolerated only while the caller
    // is still waiting, not for the whole grace period.
    mockedArchive.mockResolvedValueOnce({ data: record("DEPLOYED") } as never);
    mockedGet.mockResolvedValue({ data: record("DEPLOYED") } as never);

    await expect(instance().archive({ interval: 0, maxWait: 0 })).rejects.toThrow(/is DEPLOYED/);
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("unarchive() can be called on the class with a name and waits for the restore", async () => {
    mockedUnarchive.mockResolvedValueOnce({ data: record("UNARCHIVING") } as never);
    mockedGet
      .mockResolvedValueOnce({ data: record("UNARCHIVING") } as never)
      .mockResolvedValueOnce({ data: record("DEPLOYED") } as never);

    const result = await SandboxInstance.unarchive("my-sandbox", { interval: 0 });

    expect(path(mockedUnarchive)).toBe("my-sandbox");
    expect(result).toBeInstanceOf(SandboxInstance);
    expect(result.status).toBe("DEPLOYED");
  });
});
