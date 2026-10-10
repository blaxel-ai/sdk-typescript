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
import { SandboxDriveSetupError, SandboxInstance } from "../../@blaxel/core/src/sandbox/sandbox.js";

const drive = (name: string, region = "us-was-1") => new DriveInstance({ metadata: { name }, spec: { region } });
const mounted = (overrides = {}) => ({ driveName: "data", mountPath: "/mnt/data", drivePath: "/", readOnly: false, ...overrides });
const config = { image: "blaxel/base-image:latest", region: "us-was-1" };
const existing = { driveName: "data", mountPath: "/mnt/data" };

async function setupError(promise: Promise<unknown>) {
  const error: unknown = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SandboxDriveSetupError);
  return error as SandboxDriveSetupError;
}

describe("SandboxInstance.create mountDrives", () => {
  let mount: MockInstance<SandboxDrive["mount"]>;
  let list: MockInstance<SandboxDrive["list"]>;

  beforeEach(() => {
    mount = vi.spyOn(SandboxDrive.prototype, "mount");
    list = vi.spyOn(SandboxDrive.prototype, "list");
    vi.mocked(createSandbox).mockReset().mockResolvedValue({
      data: { metadata: { name: "sandbox" }, spec: { region: "us-was-1", runtime: {} }, status: "DEPLOYED" },
      response: { status: 200 }, request: {},
    } as never);
    vi.spyOn(settings, "disableH2", "get").mockReturnValue(true);
    vi.spyOn(DriveInstance, "get").mockResolvedValue(drive("data"));
    vi.spyOn(DriveInstance, "create").mockResolvedValue(drive("drive-1234abcd"));
    vi.spyOn(DriveInstance, "delete").mockResolvedValue({});
    vi.spyOn(SandboxInstance, "delete");
    vi.spyOn(SandboxDrive.prototype, "unmount");
    mount.mockResolvedValue({ success: true });
    list.mockResolvedValue([mounted()]);
  });

  afterEach(() => {
    // These cases only use existing drives or succeed: nothing is deleted or unmounted.
    expect(DriveInstance.delete).not.toHaveBeenCalled();
    expect(SandboxInstance.delete).not.toHaveBeenCalled();
    expect(SandboxDrive.prototype.unmount).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("does nothing extra when mountDrives is omitted", async () => {
    await SandboxInstance.create(config);
    expect(DriveInstance.get).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("mounts an existing drive with its name only, then checks the mount", async () => {
    await SandboxInstance.create(config, { mountDrives: [existing] });
    expect(DriveInstance.get).toHaveBeenCalledExactlyOnceWith("data");
    expect(DriveInstance.create).not.toHaveBeenCalled();
    expect(mount).toHaveBeenCalledExactlyOnceWith({ driveName: "data", mountPath: "/mnt/data", drivePath: "/", readOnly: false });
    expect(list).toHaveBeenCalledOnce();
  });

  it.each([
    ["a trailing slash on mountPath", { mountPath: "/mnt/data/" }, {}],
    ["a relative mountPath", { mountPath: "mnt/data" }, {}],
    ["a trailing slash on drivePath", { drivePath: "/sub/" }, { drivePath: "/sub" }],
  ])("accepts a mount the sandbox lists with a normalised path: %s", async (_label, requested, listed) => {
    list.mockResolvedValue([mounted(listed)]);
    await SandboxInstance.create(config, { mountDrives: [{ ...existing, ...requested }] });
    expect(list).toHaveBeenCalledOnce();
  });

  it("creates new drives in the sandbox's region; a named one is reused if it exists", async () => {
    vi.mocked(DriveInstance.create).mockImplementation(config => Promise.resolve(drive((config as { name: string }).name)));
    list.mockImplementation(() => Promise.resolve(mount.mock.calls.map(([request]) => mounted(request))));
    await SandboxInstance.create(config, {
      mountDrives: [{ create: {}, mountPath: "/mnt/data" }, { create: { name: "app-data" }, mountPath: "/mnt/app" }],
    });
    // An unnamed drive is named here, so a create whose response is lost can be looked up.
    expect(DriveInstance.create).toHaveBeenCalledWith({ name: expect.stringMatching(/^drive-[0-9a-f]{16}$/) as unknown, region: "us-was-1" });
    expect(DriveInstance.create).toHaveBeenCalledWith({ name: "app-data", region: "us-was-1" });
    expect(DriveInstance.get).not.toHaveBeenCalled();
  });

  it("reuses a named drive that already exists", async () => {
    vi.mocked(DriveInstance.create).mockRejectedValue({ code: 409 });
    vi.mocked(DriveInstance.get).mockResolvedValue(drive("app-data"));
    list.mockResolvedValue([mounted({ driveName: "app-data" })]);
    await SandboxInstance.create(config, { mountDrives: [{ create: { name: "app-data" }, mountPath: "/mnt/data" }] });
    expect(DriveInstance.get).toHaveBeenCalledExactlyOnceWith("app-data");
  });

  it("rejects a drive from another region, keeping the sandbox and mounting nothing", async () => {
    vi.mocked(DriveInstance.get).mockResolvedValue(drive("data", "eu-lon-1"));
    const error = await setupError(SandboxInstance.create(config, { mountDrives: [existing] }));
    expect(error.message).toContain("eu-lon-1");
    expect(error.driveNames).toEqual(["data"]);
    expect(error.sandbox?.metadata.name).toBe("sandbox");
    expect(mount).not.toHaveBeenCalled();
  });

  it("keeps the sandbox and earlier mounts when a mount fails, and reports the cause", async () => {
    const cause = new Error("409 mount path already in use");
    mount.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(cause);
    vi.mocked(DriveInstance.get).mockImplementation(name => Promise.resolve(drive(name)));
    const error = await setupError(SandboxInstance.create(config, {
      mountDrives: [existing, { driveName: "other", mountPath: "/mnt/other" }],
    }));
    expect(error.cause).toBe(cause);
    expect(error.driveNames).toEqual(["data", "other"]);
    expect(error.sandbox?.metadata.name).toBe("sandbox");
  });

  it("puts the body of a plain-object cause in the message", async () => {
    vi.mocked(DriveInstance.get).mockRejectedValue({ code: 404, error: "Drive not found" });
    const error = await setupError(SandboxInstance.create(config, { mountDrives: [existing] }));
    expect(error.message).toContain('"error":"Drive not found"');
  });

  it.each([
    ["read-only", { readOnly: true }, { readOnly: false }],
    ["drive path", { drivePath: "/sub" }, { drivePath: "/" }],
    ["drive", {}, { driveName: "other" }],
  ])("fails when the sandbox reports a different %s than requested", async (_label, requested, actual) => {
    // e.g. createIfNotExist returned a sandbox that already mounts the path differently.
    list.mockResolvedValue([mounted(actual)]);
    const error = await setupError(SandboxInstance.create(config, { mountDrives: [{ ...existing, ...requested }] }));
    expect(error.message).toContain("/mnt/data is not mounted as requested");
  });

  it.each([
    ["both driveName and create", { driveName: "data", create: {}, mountPath: "/mnt/data" }, false],
    ["neither driveName nor create", { mountPath: "/mnt/data" }, false],
    ["an unnamed new drive with createIfNotExist", { create: {}, mountPath: "/mnt/data" }, true],
  ])("rejects %s before creating the sandbox", async (_label, entry, createIfNotExist) => {
    await expect(SandboxInstance.create(config, { createIfNotExist, mountDrives: [entry as never] })).rejects.toThrow(TypeError);
    expect(createSandbox).not.toHaveBeenCalled();
  });
});
