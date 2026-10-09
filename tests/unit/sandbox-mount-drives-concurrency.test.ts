// Vitest asserts on method references (spies) and never calls them detached.
/* eslint-disable @typescript-eslint/unbound-method */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("../../@blaxel/core/src/client/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../@blaxel/core/src/client/index.js")>();
  return { ...actual, createSandbox: vi.fn() };
});

import { createSandbox } from "../../@blaxel/core/src/client/index.js";
import { settings } from "../../@blaxel/core/src/common/settings.js";
import { DriveInstance } from "../../@blaxel/core/src/drive/index.js";
import { SandboxDrive } from "../../@blaxel/core/src/sandbox/drive/index.js";
import { MOUNT_DRIVES_CONCURRENCY } from "../../@blaxel/core/src/sandbox/mount-drives.js";
import { SandboxDriveSetupError, SandboxInstance } from "../../@blaxel/core/src/sandbox/sandbox.js";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T = void>(): Deferred<T> {
  const d = {} as Deferred<T>;
  d.promise = new Promise<T>((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  return d;
}
// Let every pending promise callback run.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const REGION = "us-was-1";
const drive = (name: string, region = REGION) => new DriveInstance({ metadata: { name }, spec: { region } });
const sandboxResponse = { data: { metadata: { name: "sandbox" }, spec: { region: REGION, runtime: {} }, status: "DEPLOYED" }, response: { status: 200 }, request: {} };
const config = { image: "blaxel/base-image:latest", region: REGION };
const entry = (name: string) => ({ create: { name }, mountPath: `/mnt/${name}` });

describe("SandboxInstance.create mountDrives concurrency", () => {
  let mount: MockInstance<SandboxDrive["mount"]>;
  let list: MockInstance<SandboxDrive["list"]>;
  let mounted: { driveName: string; mountPath: string; drivePath: string; readOnly: boolean }[];

  beforeEach(() => {
    mounted = [];
    mount = vi.spyOn(SandboxDrive.prototype, "mount").mockImplementation(request => {
      mounted.push({ drivePath: "/", readOnly: false, ...request });
      return Promise.resolve({ success: true });
    });
    list = vi.spyOn(SandboxDrive.prototype, "list").mockImplementation(() => Promise.resolve([...mounted]));
    vi.mocked(createSandbox).mockReset().mockResolvedValue(sandboxResponse as never);
    vi.spyOn(settings, "disableH2", "get").mockReturnValue(true);
    vi.spyOn(DriveInstance, "get").mockImplementation(name => Promise.resolve(drive(name)));
    vi.spyOn(DriveInstance, "create").mockImplementation(c => Promise.resolve(drive((c as { name: string }).name)));
    vi.spyOn(DriveInstance, "delete").mockResolvedValue({} as never);
    vi.spyOn(SandboxInstance, "delete");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts the sandbox and the drive creations before either finishes", async () => {
    const sandbox = deferred<typeof sandboxResponse>();
    const driveA = deferred<DriveInstance>();
    const driveB = deferred<DriveInstance>();
    vi.mocked(createSandbox).mockReturnValue(sandbox.promise as never);
    vi.mocked(DriveInstance.create).mockReturnValueOnce(driveA.promise).mockReturnValueOnce(driveB.promise);

    const created = SandboxInstance.create(config, { mountDrives: [entry("a"), entry("b")] });
    await settle();
    expect(createSandbox).toHaveBeenCalledOnce();
    expect(DriveInstance.create).toHaveBeenCalledTimes(2);
    expect(DriveInstance.create).toHaveBeenCalledWith({ name: "a", region: REGION });
    expect(DriveInstance.create).toHaveBeenCalledWith({ name: "b", region: REGION });
    expect(mount).not.toHaveBeenCalled();

    // A drive that is ready waits for the sandbox: mounting needs both.
    driveA.resolve(drive("a"));
    driveB.resolve(drive("b"));
    await settle();
    expect(mount).not.toHaveBeenCalled();

    sandbox.resolve(sandboxResponse);
    await created;
    expect(mount).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledOnce();
  });

  it("does not wait for the slowest drive to mount the others, and never mounts before the sandbox", async () => {
    const slow = deferred<DriveInstance>();
    vi.mocked(DriveInstance.create).mockImplementation(c => (c as { name: string }).name === "slow" ? slow.promise : Promise.resolve(drive("fast")));
    const created = SandboxInstance.create(config, { mountDrives: [entry("slow"), entry("fast")] });
    await settle();
    expect(mount).toHaveBeenCalledExactlyOnceWith({ driveName: "fast", mountPath: "/mnt/fast", drivePath: "/", readOnly: false });
    slow.resolve(drive("slow"));
    await created;
    expect(mount).toHaveBeenCalledTimes(2);
  });

  it("looks up an existing drive while the sandbox is being created", async () => {
    const sandbox = deferred<typeof sandboxResponse>();
    vi.mocked(createSandbox).mockReturnValue(sandbox.promise as never);
    const created = SandboxInstance.create(config, { mountDrives: [{ driveName: "data", mountPath: "/mnt/data" }] });
    await settle();
    expect(DriveInstance.get).toHaveBeenCalledExactlyOnceWith("data");
    expect(mount).not.toHaveBeenCalled();
    sandbox.resolve(sandboxResponse);
    await created;
    expect(mount).toHaveBeenCalledOnce();
  });

  it("creates and mounts at most MOUNT_DRIVES_CONCURRENCY drives at a time", async () => {
    const total = MOUNT_DRIVES_CONCURRENCY * 2 + 1;
    const names = Array.from({ length: total }, (_, i) => `d${i}`);
    let creating = 0, mounting = 0, maxCreating = 0, maxMounting = 0;
    vi.mocked(DriveInstance.create).mockImplementation(async c => {
      maxCreating = Math.max(maxCreating, ++creating);
      await settle();
      creating--;
      return drive((c as { name: string }).name);
    });
    mount.mockImplementation(async request => {
      maxMounting = Math.max(maxMounting, ++mounting);
      await settle();
      mounting--;
      mounted.push({ drivePath: "/", readOnly: false, ...request });
      return { success: true };
    });
    await SandboxInstance.create(config, { mountDrives: names.map(entry) });
    expect(DriveInstance.create).toHaveBeenCalledTimes(total);
    expect(mount).toHaveBeenCalledTimes(total);
    expect(maxCreating).toBe(MOUNT_DRIVES_CONCURRENCY);
    expect(maxMounting).toBe(MOUNT_DRIVES_CONCURRENCY);
  });

  it("when the sandbox's region is not known up front, creates drives once it is created, in its region", async () => {
    vi.spyOn(settings, "region", "get").mockReturnValue(undefined as never);
    const sandbox = deferred<typeof sandboxResponse>();
    vi.mocked(createSandbox).mockReturnValue(sandbox.promise as never);
    const lookedUp = vi.mocked(DriveInstance.get);
    const created = SandboxInstance.create({ image: config.image }, { mountDrives: [entry("a"), { driveName: "data", mountPath: "/mnt/data" }] });
    await settle();
    expect(lookedUp).toHaveBeenCalledExactlyOnceWith("data");
    expect(DriveInstance.create).not.toHaveBeenCalled();
    sandbox.resolve(sandboxResponse);
    await created;
    expect(DriveInstance.create).toHaveBeenCalledExactlyOnceWith({ name: "a", region: REGION });
  });

  describe("failures", () => {
    it("deletes the drives it created, and only those, when the sandbox cannot be created", async () => {
      const failure = new Error("quota exceeded");
      const sandbox = deferred<typeof sandboxResponse>();
      vi.mocked(createSandbox).mockReturnValue(sandbox.promise as never);
      vi.mocked(DriveInstance.create).mockImplementation(c => (c as { name: string }).name === "old" ? Promise.reject({ code: 409 }) : Promise.resolve(drive((c as { name: string }).name)));
      const result = SandboxInstance.create(config, { mountDrives: [entry("new"), entry("old"), { driveName: "data", mountPath: "/mnt/data" }] }).catch((e: unknown) => e);
      await settle();
      sandbox.reject(failure);
      expect(await result).toBe(failure);
      expect(DriveInstance.delete).toHaveBeenCalledExactlyOnceWith("new");
      expect(mount).not.toHaveBeenCalled();
    });

    it("waits for a drive still being created before deleting it", async () => {
      const slow = deferred<DriveInstance>();
      vi.mocked(createSandbox).mockRejectedValue(new Error("boom"));
      vi.mocked(DriveInstance.create).mockReturnValue(slow.promise);
      const result = SandboxInstance.create(config, { mountDrives: [entry("slow")] }).catch((e: unknown) => e);
      await settle();
      expect(DriveInstance.delete).not.toHaveBeenCalled();
      slow.resolve(drive("slow"));
      expect(await result).toEqual(new Error("boom"));
      expect(DriveInstance.delete).toHaveBeenCalledExactlyOnceWith("slow");
    });

    it("does not create drives for a sandbox that failed before its region was known", async () => {
      vi.spyOn(settings, "region", "get").mockReturnValue(undefined as never);
      vi.mocked(createSandbox).mockRejectedValue(new Error("boom"));
      await expect(SandboxInstance.create({ image: config.image }, { mountDrives: [entry("a")] })).rejects.toThrow("boom");
      expect(DriveInstance.create).not.toHaveBeenCalled();
      expect(DriveInstance.delete).not.toHaveBeenCalled();
    });

    it("keeps the sandbox and what exists when one drive fails, starts no more drives and reports the cause", async () => {
      const total = MOUNT_DRIVES_CONCURRENCY + 3;
      const cause = new Error("drive quota");
      const sandbox = deferred<typeof sandboxResponse>();
      vi.mocked(createSandbox).mockReturnValue(sandbox.promise as never);
      const gate = deferred();
      vi.mocked(DriveInstance.create).mockImplementation(async c => {
        if ((c as { name: string }).name === "d1") throw cause;
        await gate.promise;
        return drive((c as { name: string }).name);
      });
      const result = SandboxInstance.create(config, { mountDrives: Array.from({ length: total }, (_, i) => entry(`d${i}`)) }).catch((e: unknown) => e);
      await settle();
      gate.resolve();
      sandbox.resolve(sandboxResponse);
      const error = await result;
      expect(error).toBeInstanceOf(SandboxDriveSetupError);
      const { sandbox: kept, driveNames, cause: reported } = error as SandboxDriveSetupError;
      expect(reported).toBe(cause);
      expect(kept.metadata.name).toBe("sandbox");
      // Drives in flight when d1 failed finished; the queued ones were never started.
      expect(DriveInstance.create).toHaveBeenCalledTimes(MOUNT_DRIVES_CONCURRENCY);
      expect(driveNames).toEqual(["d0", "d2", "d3", "d4"]);
      expect(mount).not.toHaveBeenCalled();
      expect(DriveInstance.delete).not.toHaveBeenCalled();
      expect(SandboxInstance.delete).not.toHaveBeenCalled();
    });

    it("keeps the sandbox and the other mounts when one mount fails", async () => {
      const cause = new Error("409 mount path already in use");
      mount.mockImplementation(request => {
        if (request.driveName === "b") return Promise.reject(cause);
        mounted.push({ drivePath: "/", readOnly: false, ...request });
        return Promise.resolve({ success: true });
      });
      const error = await SandboxInstance.create(config, { mountDrives: [entry("a"), entry("b"), entry("c")] }).catch((e: unknown) => e) as SandboxDriveSetupError;
      expect(error).toBeInstanceOf(SandboxDriveSetupError);
      expect(error.cause).toBe(cause);
      expect(error.driveNames).toEqual(["a", "b", "c"]);
      expect(list).not.toHaveBeenCalled();
      expect(DriveInstance.delete).not.toHaveBeenCalled();
      expect(SandboxInstance.delete).not.toHaveBeenCalled();
    });
  });
});
